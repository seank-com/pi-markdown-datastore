import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { StoreConfig } from "./config.ts";
import { assertRootIdentity, noteRefToUri, safeInspectContainedFile, safeOpenNote, walkSafeAttachmentPaths, walkSafeNoteMetadata, type SafeNote, type SafeNoteMetadata } from "./containment.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import type { MaintenanceCoordinator } from "./maintenance-coordinator.ts";
import { parseMarkdown } from "./markdown.ts";
import { extractWikilinks, tagIdentity } from "./wiki.ts";

export interface MetadataEdge {
	kind: "link" | "embed";
	source: string;
	target: string;
	targetKind: "note" | "attachment" | "unresolved" | "ambiguous";
	fragment?: string;
	suffix?: string;
	raw: string;
	line: number;
	written?: string;
}
export interface MetadataTag { identity: string; spelling: string; pages: string[] }
export interface FileLink { target: string; kind: "link" | "embed"; fragment?: string; suffix?: string; raw: string; line: number; targetKind?: MetadataEdge["targetKind"] }
export interface FileRecord { kind: "note" | "attachment"; mtime: string; revision?: string; size?: number; links?: FileLink[]; tags?: string[] }
export interface MetadataSnapshot {
	version: 2;
	revision: string;
	root?: string;
	rootDev?: number;
	rootIno?: number;
	complete: boolean;
	diagnostics: string[];
	files: Record<string, FileRecord>;
	targets: Record<string, string[]>;
	tags: Record<string, string[]>;
	references: Record<string, string[]>;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
	await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
	const handle = await open(temp, constants.O_RDONLY);
	await handle.sync();
	await handle.close();
	await rename(temp, path);
}

export class MetadataIndex {
	readonly root: string;
	#snapshot?: MetadataSnapshot;
	constructor(stateDirectory: string) { this.root = stateDirectory; }
	private async load(): Promise<MetadataSnapshot | undefined> {
		if (this.#snapshot) return this.#snapshot;
		const path = join(this.root, "index.json");
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new DatastoreError("INDEX_CORRUPT");
			const saved = JSON.parse(await readFile(path, "utf8")) as MetadataSnapshot;
			if (saved.version !== 2 || typeof saved.revision !== "string" || !saved.files) return undefined;
			saved.files = own(saved.files);
			saved.targets = own(saved.targets);
			saved.tags = own(saved.tags);
			saved.references = own(saved.references);
			this.#snapshot = saved;
			return saved;
		} catch (error: any) {
			if (error?.code === "ENOENT") return undefined;
			if (error instanceof DatastoreError) throw error;
			throw new DatastoreError("INDEX_CORRUPT");
		}
	}
	async snapshot(): Promise<MetadataSnapshot | undefined> { return this.load(); }
	async requireSnapshot(): Promise<MetadataSnapshot> { const snapshot = await this.load(); if (!snapshot) throw new DatastoreError("STALE_INDEX"); return snapshot; }
	async links(path: string): Promise<MetadataEdge[]> { return edgesFrom(await this.requireSnapshot(), "links", path); }
	async backlinks(path: string): Promise<MetadataEdge[]> { return edgesFrom(await this.requireSnapshot(), "backlinks", path); }
	async tagPages(identity: string): Promise<string[]> { const tags = (await this.requireSnapshot()).tags; return Object.hasOwn(tags, identity) ? tags[identity] : []; }
	async catalog(): Promise<MetadataTag[]> { return catalogFrom(await this.requireSnapshot()); }
	fileRevision(path: string, snapshot: MetadataSnapshot): string | undefined { return snapshot.files[path]?.revision; }
	async updatePaths(store: StoreConfig, paths: string[], signal?: AbortSignal): Promise<MetadataSnapshot> {
		const loaded = await this.load();
		const files = own(loaded?.files);
		const diagnostics = [...(loaded?.diagnostics ?? [])].filter((line) => !paths.some((path) => line.startsWith(`${path}:`)));
		for (const path of paths) {
			throwIfAborted(signal);
			if (!path.endsWith(".md")) {
				try { const inspected = await safeInspectContainedFile(store, path, signal); files[path] = { kind: "attachment", mtime: inspected.mtime, size: inspected.size }; }
				catch (error) { if (error instanceof DatastoreError && error.code === "NOTE_NOT_FOUND") delete files[path]; else throw error; }
				continue;
			}
			try {
				const opened = await safeOpenNote(store, path, signal);
				const prior = files[path];
				if (prior?.kind === "note" && prior.revision === opened.revision) { files[path] = { ...prior, mtime: opened.mtime, size: opened.size }; continue; }
				const recorded = recordNote(opened);
				diagnostics.push(...recorded.diagnostics);
				files[path] = recorded.file;
			} catch (error) { if (error instanceof DatastoreError && error.code === "NOTE_NOT_FOUND") delete files[path]; else throw error; }
		}
		return this.#publish(store, files, diagnostics);
	}
	async reconcile(store: StoreConfig, signal?: AbortSignal): Promise<MetadataSnapshot> {
		const snapshot = await this.load();
		if (!snapshot) return this.rebuild(store, signal);
		const changed: string[] = []; const seen = new Set<string>();
		await walkSafeNoteMetadata(store, (note) => { seen.add(note.note.path); const prior = Object.hasOwn(snapshot.files, note.note.path) ? snapshot.files[note.note.path] : undefined; if (!prior || prior.mtime !== note.mtime) changed.push(note.note.path); }, signal);
		await walkSafeAttachmentPaths(store, async (path) => { seen.add(path); const inspected = await safeInspectContainedFile(store, path, signal); const prior = Object.hasOwn(snapshot.files, path) ? snapshot.files[path] : undefined; if (!prior || prior.mtime !== inspected.mtime || prior.size !== inspected.size) changed.push(path); }, signal);
		for (const path of Object.keys(snapshot.files)) if (!seen.has(path)) changed.push(path);
		return changed.length ? this.updatePaths(store, changed, signal) : snapshot;
	}
	async rebuild(store: StoreConfig, signal?: AbortSignal): Promise<MetadataSnapshot> { return this.refresh(store, signal); }
	async #publish(store: StoreConfig, files: Record<string, FileRecord>, diagnostics: string[]): Promise<MetadataSnapshot> {
		const next = reindex(store, { version: 2, revision: "", root: store.root, rootDev: store.rootDev, rootIno: store.rootIno, complete: diagnostics.length === 0, diagnostics, files, targets: own(), tags: own(), references: own() });
		try { await atomicJson(join(this.root, "index.json"), next); } catch (error) { throw error; }
		this.#snapshot = next;
		return next;
	}
	async refresh(store: StoreConfig, signal?: AbortSignal): Promise<MetadataSnapshot> {
		throwIfAborted(signal);
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const notes: SafeNoteMetadata[] = [];
		await walkSafeNoteMetadata(store, (note) => { notes.push(note); }, signal);
		const files: string[] = [];
		const observed = new Map<string, { size: number; mtime: string; sourceRevision?: string }>();
		for (const note of notes) observed.set(note.note.path, { size: note.size, mtime: note.mtime });
		await walkSafeAttachmentPaths(store, async (path) => { const inspected = await safeInspectContainedFile(store, path, signal); observed.set(path, { size: inspected.size, mtime: inspected.mtime }); files.push(path); }, signal);
		const records = own<FileRecord>();
		const diagnostics: string[] = [];
		for (const note of notes) {
			throwIfAborted(signal);
			const opened = await safeOpenNote(store, note.note.path, signal);
			const recorded = recordNote(opened);
			diagnostics.push(...recorded.diagnostics);
			records[note.note.path] = recorded.file;
		}
		for (const path of files) { const seen = observed.get(path); records[path] = { kind: "attachment", mtime: seen?.mtime ?? "", size: seen?.size }; }
		await assertRootIdentity(store);
		return this.#publish(store, records, diagnostics);
	}
	async admit(store: StoreConfig, paths: { path: string; kind: "note" | "attachment" }[], signal?: AbortSignal): Promise<{ snapshot: MetadataSnapshot; current: boolean; diagnostics: string[] }> {
		await assertRootIdentity(store);
		const snapshot = await this.requireSnapshot();
		const diagnostics: string[] = [];
		const sameRoot = snapshot.root === store.root && snapshot.rootDev === store.rootDev && snapshot.rootIno === store.rootIno;
		if (!sameRoot) diagnostics.push(`${snapshot.revision}: source root changed`);
		const seen = new Set<string>();
		for (const item of paths) {
			const key = `${item.kind}:${item.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			try {
				const prior = snapshot.files[item.path];
				if (item.kind === "note") {
					const opened = await safeOpenNote(store, item.path, signal);
					if (!prior?.revision || prior.revision !== opened.revision) diagnostics.push(`${snapshot.revision}: ${item.path}: changed`);
				} else {
					const inspected = await safeInspectContainedFile(store, item.path, signal);
					if (!prior || prior.size !== inspected.size || prior.mtime !== inspected.mtime) diagnostics.push(`${snapshot.revision}: ${item.path}: changed`);
				}
			} catch (error) {
				if (!(error instanceof DatastoreError) || error.code === "STORE_UNAVAILABLE") throw error;
				diagnostics.push(`${snapshot.revision}: ${item.path}: ${error.code}`);
			}
		}
		return { snapshot, current: sameRoot && snapshot.complete && diagnostics.length === 0, diagnostics };
	}
	async shutdown(): Promise<void> { this.#snapshot = undefined; }
}

function catalogFrom(snapshot: MetadataSnapshot): MetadataTag[] {
	return Object.entries(snapshot.tags).map(([identity, pages]) => ({ identity, spelling: pages.map((path) => snapshot.files[path]?.tags?.find((tag) => tagIdentity(tag) === identity)).find(Boolean) ?? identity, pages }));
}
function edgesFrom(snapshot: MetadataSnapshot, view: "links" | "backlinks", path: string): MetadataEdge[] {
	const present = (source: string, link: FileLink): MetadataEdge => ({ ...link, ...resolveWritten(snapshot, link.target, source), source });
	if (view === "links") return (snapshot.files[path]?.links ?? []).map((link) => present(path, link));
	const sources = new Set<string>();
	for (const [written, referring] of Object.entries(snapshot.references)) {
		for (const source of referring) {
			const resolved = resolveWritten(snapshot, written, source);
			if (resolved.target === path && resolved.targetKind !== "unresolved" && resolved.targetKind !== "ambiguous") sources.add(source);
		}
	}
	return [...sources].flatMap((source) => (snapshot.files[source]?.links ?? []).filter((link) => resolveWritten(snapshot, link.target, source).target === path).map((link) => present(source, link)));
}
function resolveWritten(snapshot: MetadataSnapshot, written: string, source?: string): Pick<MetadataEdge, "target" | "targetKind"> {
	if (!written && source) return { target: source, targetKind: "note" };
	if (written.includes("\\") || written.split("/").includes("..")) return { target: written, targetKind: "unresolved" };
	if (written.includes("/")) {
		const withMd = written.endsWith(".md") ? written : `${written}.md`;
		if (snapshot.files[written]?.kind === "note" || snapshot.files[written]?.kind === "attachment") return { target: written, targetKind: snapshot.files[written].kind === "attachment" ? "attachment" : "note" };
		if (snapshot.files[withMd]?.kind === "note") return { target: withMd, targetKind: "note" };
		return { target: written, targetKind: "unresolved" };
	}
	const stem = basename(written, extname(written));
	let candidates = snapshot.targets[stem] ?? [];
	if (extname(written)) candidates = candidates.filter((path) => basename(path) === written);
	if (candidates.length === 1) return { target: candidates[0], targetKind: snapshot.files[candidates[0]]?.kind === "attachment" ? "attachment" : "note" };
	if (candidates.length > 1) return { target: written, targetKind: "ambiguous" };
	return { target: written, targetKind: "unresolved" };
}
function own<T = unknown>(source?: object): Record<string, T> {
	const out = Object.create(null) as Record<string, T>;
	if (source) for (const [key, value] of Object.entries(source)) out[key] = value as T;
	return out;
}
function recordNote(opened: SafeNote): { file: FileRecord; diagnostics: string[] } {
	const parsed = parseMarkdown(opened);
	const diagnostics: string[] = [];
	if (parsed.frontmatter.error) diagnostics.push(`${opened.note.path}: ${parsed.frontmatter.error}`);
	const rawTags = parsed.frontmatter.value?.tags;
	if (rawTags !== undefined && typeof rawTags !== "string" && !(Array.isArray(rawTags) && rawTags.every((item) => typeof item === "string"))) diagnostics.push(`${opened.note.path}: invalid tag shape`);
	const spellings = typeof rawTags === "string" ? [rawTags] : Array.isArray(rawTags) && rawTags.every((item) => typeof item === "string") ? rawTags : [];
	const links = extractWikilinks(opened.text, parsed.frontmatter.endLine ?? 0).map((ref) => ({ target: ref.target, kind: ref.kind, fragment: ref.fragment, suffix: ref.suffix, raw: ref.raw, line: ref.line }));
	return { file: { kind: "note", mtime: opened.mtime, size: opened.size, revision: opened.revision, links, tags: spellings }, diagnostics };
}
function reindex(store: StoreConfig, current: MetadataSnapshot): MetadataSnapshot {
	const targets = own<string[]>();
	const tags = own<string[]>();
	const references = own<string[]>();
	const add = (map: Record<string, string[]>, key: string, value: string) => { const existing = Object.hasOwn(map, key) ? map[key] : []; if (!existing.includes(value)) existing.push(value); map[key] = existing; };
	for (const [path, file] of Object.entries(current.files)) {
		add(targets, basename(path, extname(path)), path);
		if (file.kind !== "note") continue;
		for (const spelling of file.tags ?? []) { const identity = tagIdentity(spelling); if (identity) add(tags, identity, path); }
		for (const link of file.links ?? []) {
			add(references, link.target, path);
			if (link.target && !link.target.includes("/") && !link.target.includes("\\") && !Object.hasOwn(targets, basename(link.target, extname(link.target)))) targets[basename(link.target, extname(link.target))] = [];
		}
	}
	for (const list of [targets, tags, references]) for (const key of Object.keys(list)) list[key].sort(); return { ...current, version: 2, revision: `meta-${randomBytes(16).toString("hex")}`, root: store.root, rootDev: store.rootDev, rootIno: store.rootIno, complete: current.diagnostics.length === 0, targets, tags, references };
}

export async function reconcileChanged(coordinator: MaintenanceCoordinator, indexes: Map<string, MetadataIndex>, stores: ReadonlyMap<string, StoreConfig>): Promise<void> {
	for (const [name, store] of stores) {
		if (store.shared) continue;
		const index = indexes.get(name); if (!index) continue;
		const snapshot = await index.snapshot();
		const changed: string[] = []; const seen = new Set<string>();
		await walkSafeNoteMetadata(store, (note) => { seen.add(note.note.path); const prior = snapshot?.files[note.note.path]; if (!prior || prior.mtime !== note.mtime) changed.push(note.note.path); });
		await walkSafeAttachmentPaths(store, async (path) => { seen.add(path); const inspected = await safeInspectContainedFile(store, path); const prior = snapshot?.files[path]; if (!prior || prior.mtime !== inspected.mtime || prior.size !== inspected.size) changed.push(path); });
		for (const path of Object.keys(snapshot?.files ?? {})) if (!seen.has(path)) changed.push(path);
		if (!changed.length) continue;
		coordinator.notePaths(name, changed);
		const receipt = await coordinator.enqueue("metadata", [name], "startup-reconciliation");
		await coordinator.persisted(String(receipt.refreshId));
		if (coordinator.hasRunner("lexical")) await coordinator.enqueue("lexical", [name], "startup-reconciliation");
	}
}
export function registerMetadata(coordinator: MaintenanceCoordinator, indexes: Map<string, MetadataIndex>, stores: ReadonlyMap<string, StoreConfig>): void {
	coordinator.register("metadata", async (job, signal) => {
		let revision = "";
		for (const name of job.stores) {
			const index = indexes.get(name);
			const store = stores.get(name);
			if (!index || !store) throw new DatastoreError("STORE_UNKNOWN");
			const paths = coordinator.takePaths(name);
			revision = (paths.length ? await index.updatePaths(store, paths, signal) : await index.refresh(store, signal)).revision;
		}
		return { generation: revision };
	});
}

export function tagCandidate(store: string, path: string, revision: string): { note: { store: string; path: string }; uri: string; title: string; revision: string } {
	const note = { store, path };
	return { note, uri: noteRefToUri(note), title: path, revision };
}

export function pageRendered<T>(items: T[], offset: number, budget: { maxBytes: number; maxLines: number }, render: (page: T[]) => unknown): { items: T[]; next?: number } {
	if (!Number.isInteger(offset) || offset < 0 || offset > items.length) throw new DatastoreError("STALE_CONTINUATION");
	const selected: T[] = [];
	let index = offset;
	for (; index < items.length; index += 1) {
		const candidate = [...selected, items[index]];
		const text = JSON.stringify(render(candidate));
		if (Buffer.byteLength(text) > budget.maxBytes || text.split("\n").length > budget.maxLines) {
			if (selected.length === 0) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
			break;
		}
		selected.push(items[index]);
	}
	return { items: selected, next: index < items.length ? index : undefined };
}

function decodePageToken(token: string): { store?: string; revision?: string; query?: string; offset?: number; maxBytes?: number; maxLines?: number } {
	let parsed: unknown;
	try { parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); }
	catch { throw new DatastoreError("STALE_CONTINUATION"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DatastoreError("STALE_CONTINUATION");
	return parsed as { store?: string; revision?: string; query?: string; offset?: number; maxBytes?: number; maxLines?: number };
}

export function continuationOffset(token: string | undefined, store: string, revision: string, query: string): number {
	if (!token) return 0;
	const parsed = decodePageToken(token);
	if (parsed.store !== store || parsed.revision !== revision || parsed.query !== query || !Number.isInteger(parsed.offset) || (parsed.offset ?? -1) < 0) throw new DatastoreError("STALE_CONTINUATION");
	return parsed.offset ?? 0;
}

export function continuationToken(store: string, revision: string, query: string, offset: number, budget?: { maxBytes: number; maxLines: number }): string {
	return Buffer.from(JSON.stringify({ store, revision, query, offset, maxBytes: budget?.maxBytes, maxLines: budget?.maxLines })).toString("base64url");
}

export function readPageToken(token: string): { store: string; revision: string; query: string; offset: number; maxBytes?: number; maxLines?: number } {
	const parsed = decodePageToken(token);
	if (typeof parsed.store !== "string" || typeof parsed.revision !== "string" || typeof parsed.query !== "string" || !Number.isInteger(parsed.offset) || (parsed.offset ?? -1) < 0) throw new DatastoreError("STALE_CONTINUATION");
	return { store: parsed.store, revision: parsed.revision, query: parsed.query, offset: parsed.offset ?? 0, maxBytes: parsed.maxBytes, maxLines: parsed.maxLines };
}
