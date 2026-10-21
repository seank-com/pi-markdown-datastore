import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { NoteRef } from "./contract.ts";
import type { StoreConfig } from "./config.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";

export interface SafeNote {
	note: NoteRef; uri: string; bytes: Buffer; text: string; revision: string; fullRevision: string;
	mtime: string; size: number; absolutePath: string;
}
export interface SafeNoteMetadata { note: NoteRef; mtime: string; size: number }

const STORE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;
const UNRESERVED = /^[A-Za-z0-9._~-]$/;

export function validateRelativeContainedPath(path: string): string {
	if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\") || CONTROL.test(path)) throw new DatastoreError("INVALID_NOTE_REF");
	const parts = path.split("/"); if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new DatastoreError("INVALID_NOTE_REF");
	for (const part of parts) for (let index = 0; index < part.length; index += 1) { const code = part.charCodeAt(index); if (code >= 0xD800 && code <= 0xDBFF) { const next = part.charCodeAt(index + 1); if (next < 0xDC00 || next > 0xDFFF) throw new DatastoreError("INVALID_NOTE_REF"); index += 1; } else if (code >= 0xDC00 && code <= 0xDFFF) throw new DatastoreError("INVALID_NOTE_REF"); }
	return path;
}
export function validateRelativeNotePath(path: string): string { validateRelativeContainedPath(path); if (!path.endsWith(".md")) throw new DatastoreError("INVALID_NOTE_REF"); return path; }

function encodeSegment(segment: string): string {
	const bytes = new TextEncoder().encode(segment);
	let result = "";
	for (const byte of bytes) {
		const char = String.fromCharCode(byte);
		result += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return result;
}
export function noteRefToUri(note: NoteRef): string {
	if (!STORE_NAME.test(note.store)) throw new DatastoreError("INVALID_NOTE_REF");
	const path = validateRelativeNotePath(note.path);
	return `datastore://${note.store}/${path.split("/").map(encodeSegment).join("/")}`;
}
export function noteUriToRef(uri: string): NoteRef {
	if (typeof uri !== "string" || !uri.startsWith("datastore://") || /[?#]/.test(uri)) throw new DatastoreError("INVALID_NOTE_REF");
	const rest = uri.slice("datastore://".length);
	const slash = rest.indexOf("/");
	if (slash < 1) throw new DatastoreError("INVALID_NOTE_REF");
	const store = rest.slice(0, slash);
	if (!STORE_NAME.test(store) || /[@:]/.test(store)) throw new DatastoreError("INVALID_NOTE_REF");
	const encoded = rest.slice(slash + 1);
	if (encoded.length === 0 || encoded.split("/").some((segment) => segment.length === 0 || /%(?:2[fF]|5[cC]|00)/.test(segment))) throw new DatastoreError("INVALID_NOTE_REF");
	let path: string;
	try { path = encoded.split("/").map((segment) => decodeURIComponent(segment)).join("/"); } catch { throw new DatastoreError("INVALID_NOTE_REF"); }
	validateRelativeNotePath(path);
	const note = { store, path };
	if (noteRefToUri(note) !== uri) throw new DatastoreError("INVALID_NOTE_REF");
	return note;
}

function contained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Revalidate the captured real directory, including aliases introduced in its ancestry. */
export async function assertRootIdentity(store: StoreConfig): Promise<void> {
	const info = await lstat(store.root).catch(() => { throw new DatastoreError("STORE_UNAVAILABLE"); });
	const canonical = await realpath(store.root).catch(() => { throw new DatastoreError("STORE_UNAVAILABLE"); });
	if (!info.isDirectory() || info.isSymbolicLink() || canonical !== store.root || info.dev !== store.rootDev || info.ino !== store.rootIno) throw new DatastoreError("STORE_UNAVAILABLE");
}

/** Inspect existing ancestry only. Missing suffixes are allowed; no filesystem state is created. */
export async function inspectDestination(path: string, signal?: AbortSignal): Promise<string> {
	if (typeof path !== "string" || !isAbsolute(path) || CONTROL.test(path) || path.includes("\\") || path.split(sep).some(part => part === "." || part === "..")) throw new DatastoreError("INVALID_NOTE_REF");
	const target = resolve(path);
	let walked: string = sep;
	for (const part of target.split(sep).filter(Boolean)) {
		throwIfAborted(signal);
		walked = resolve(walked, part);
		const info = await lstat(walked).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw new DatastoreError("UNSAFE_FILE_TYPE");
		});
		if (!info) break;
		if (info.isSymbolicLink()) throw new DatastoreError("SYMLINK_REJECTED");
		if (!info.isDirectory() && (walked !== target || !info.isFile() || info.nlink !== 1)) throw new DatastoreError("UNSAFE_FILE_TYPE");
		const canonical = await realpath(walked).catch(() => { throw new DatastoreError("STORE_UNAVAILABLE"); });
		// Case/Unicode aliases must not turn an owned destination into an outside result.
		if (canonical !== walked) throw new DatastoreError("SYMLINK_REJECTED");
	}
	return target;
}

export function ownsDestination(root: string, target: string): boolean { return root === target || contained(root, target); }

export async function safeOpenNote(store: StoreConfig, inputPath: string, signal?: AbortSignal): Promise<SafeNote> {
	throwIfAborted(signal);
	const path = validateRelativeNotePath(inputPath);
	const target = resolve(store.root, ...path.split("/"));
	if (!contained(store.root, target)) throw new DatastoreError("PATH_ESCAPE");
	await assertRootIdentity(store);
	let walked = store.root;
	let inspected;
	for (const part of path.split("/")) {
		throwIfAborted(signal);
		walked = resolve(walked, part);
		inspected = await lstat(walked).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") throw new DatastoreError("NOTE_NOT_FOUND");
			throw new DatastoreError("UNSAFE_FILE_TYPE");
		});
		if (inspected.isSymbolicLink()) throw new DatastoreError("SYMLINK_REJECTED");
	}
	if (!inspected?.isFile() || inspected.nlink !== 1) throw new DatastoreError("UNSAFE_FILE_TYPE");
	if (inspected.size > store.maxFileBytes) throw new DatastoreError("FILE_TOO_LARGE");
	throwIfAborted(signal);
	const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new DatastoreError("NOTE_NOT_FOUND");
		if (error.code === "ELOOP") throw new DatastoreError("SYMLINK_REJECTED");
		throw new DatastoreError("UNSAFE_FILE_TYPE");
	});
	try {
		const current = await handle.stat();
		if (!current.isFile() || current.nlink !== 1 || current.dev !== inspected.dev || current.ino !== inspected.ino) throw new DatastoreError("UNSAFE_FILE_TYPE");
		if (current.size > store.maxFileBytes) throw new DatastoreError("FILE_TOO_LARGE");
		const bytes = Buffer.alloc(current.size);
		let offset = 0;
		while (offset < bytes.length) {
			throwIfAborted(signal);
			const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset !== bytes.length) throw new DatastoreError("UNSAFE_FILE_TYPE");
		if (bytes.includes(0)) throw new DatastoreError("INVALID_UTF8");
		let text: string;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new DatastoreError("INVALID_UTF8"); }
		if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
		const fullRevision = createHash("sha256").update(bytes).digest("hex");
		const note = { store: store.name, path };
		return { note, uri: noteRefToUri(note), bytes, text, revision: fullRevision.slice(0, 16), fullRevision, mtime: current.mtime.toISOString(), size: current.size, absolutePath: target };
	} finally { await handle.close(); }
}

export async function safeInspectContainedFile(store: StoreConfig, inputPath: string, signal?: AbortSignal): Promise<{ file: { store: string; path: string }; size: number; mtime: string }> {
	throwIfAborted(signal); const path = validateRelativeContainedPath(inputPath); const target = resolve(store.root, ...path.split("/")); if (!contained(store.root, target)) throw new DatastoreError("PATH_ESCAPE");
	await assertRootIdentity(store);
	let walked = store.root; let inspected: Awaited<ReturnType<typeof lstat>> | undefined;
	for (const part of path.split("/")) { throwIfAborted(signal); walked = resolve(walked, part); inspected = await lstat(walked).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") throw new DatastoreError("NOTE_NOT_FOUND"); throw new DatastoreError("UNSAFE_FILE_TYPE"); }); if (inspected.isSymbolicLink()) throw new DatastoreError("SYMLINK_REJECTED"); }
	if (!inspected?.isFile() || inspected.nlink !== 1) throw new DatastoreError("UNSAFE_FILE_TYPE"); const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try { const current = await handle.stat(); if (!current.isFile() || current.nlink !== 1 || current.dev !== inspected.dev || current.ino !== inspected.ino) throw new DatastoreError("UNSAFE_FILE_TYPE"); return { file: { store: store.name, path }, size: current.size, mtime: current.mtime.toISOString() }; } finally { await handle.close(); }
}

function globRegex(pattern: string): RegExp {
	let output = "^";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*" && pattern[index + 1] === "*") { output += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*"; index += pattern[index + 2] === "/" ? 2 : 1; }
		else if (char === "*") output += "[^/]*";
		else if (char === "?") output += "[^/]";
		else output += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${output}$`, "u");
}
function selected(store: StoreConfig, path: string): boolean {
	return store.include.some((pattern) => globRegex(pattern).test(path)) && !store.exclude.some((pattern) => globRegex(pattern).test(path));
}

async function walkSafePaths(store: StoreConfig, visitor: (path: string, metadata: Awaited<ReturnType<typeof lstat>>) => void | Promise<void>, signal?: AbortSignal, onProgress?: () => void): Promise<void> {
	await assertRootIdentity(store);
	const walk = async (directory: string, prefix: string): Promise<void> => {
		throwIfAborted(signal);
		const entries = await readdir(directory, { withFileTypes: true }); onProgress?.(); const componentNames = new Set<string>();
		for (const entry of entries) { const key = entry.name.normalize("NFC").toLocaleLowerCase("en-US"); if (componentNames.has(key)) throw new DatastoreError("STORE_UNAVAILABLE"); componentNames.add(key); }
		entries.sort((a, b) => a.name.normalize("NFC").localeCompare(b.name.normalize("NFC"), "en", { sensitivity: "variant" }));
		for (const entry of entries) {
			throwIfAborted(signal);
			const path = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = resolve(directory, entry.name);
			let metadata: Awaited<ReturnType<typeof lstat>>; try { metadata = await lstat(absolute); } catch { throw new DatastoreError("STORE_UNAVAILABLE"); } onProgress?.();
			if (metadata.isSymbolicLink()) continue;
			if (metadata.isDirectory()) {
				let canonical: string; try { canonical = await realpath(absolute); } catch { throw new DatastoreError("STORE_UNAVAILABLE"); }
				if (canonical !== absolute) throw new DatastoreError("STORE_UNAVAILABLE");
				await walk(absolute, path);
			} else if (metadata.isFile() && path.endsWith(".md") && selected(store, path)) {
				if (metadata.nlink !== 1) throw new DatastoreError("UNSAFE_FILE_TYPE");
				if (metadata.size > store.maxFileBytes) throw new DatastoreError("FILE_TOO_LARGE");
				await visitor(path, metadata);
			}
		}
	};
	await walk(store.root, "");
}

export async function walkSafeNoteMetadata(store: StoreConfig, visitor: (note: SafeNoteMetadata) => void | Promise<void>, signal?: AbortSignal, onProgress?: () => void): Promise<number> {
	let count = 0;
	await walkSafePaths(store, async (path, metadata) => { throwIfAborted(signal); await visitor({ note: { store: store.name, path }, mtime: metadata.mtime.toISOString(), size: Number(metadata.size) }); count += 1; }, signal, onProgress);
	return count;
}

export async function walkSafeNotes(store: StoreConfig, visitor: (note: SafeNote) => void | Promise<void>, signal?: AbortSignal): Promise<number> {
	let count = 0;
	await walkSafePaths(store, async (path) => { throwIfAborted(signal); await visitor(await safeOpenNote(store, path, signal)); count += 1; }, signal);
	return count;
}

export async function countSafeNotes(store: StoreConfig, signal?: AbortSignal): Promise<number> {
	return walkSafeNoteMetadata(store, () => undefined, signal);
}

export async function scanSafeNotes(store: StoreConfig, signal?: AbortSignal): Promise<SafeNote[]> {
	const notes: SafeNote[] = [];
	await walkSafeNotes(store, (note) => { notes.push(note); }, signal);
	return notes;
}

export function redactedRoot(store: StoreConfig, projectRoot: string): string {
	const rel = relative(projectRoot, store.root);
	return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel.split(sep).join("/") : `<external>/${basename(store.root)}`;
}
