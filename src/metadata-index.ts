import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { StoreConfig } from "./config.ts";
import { assertRootIdentity, noteRefToUri, safeInspectContainedFile, safeOpenNote, walkSafeAttachmentPaths, walkSafeNoteMetadata, type SafeNoteMetadata } from "./containment.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import type { MaintenanceCoordinator } from "./maintenance-coordinator.ts";
import { parseMarkdown } from "./markdown.ts";
import { extractWikilinks, tagIdentity, type WikiReference } from "./wiki.ts";

export interface MetadataEdge {
	kind: "link" | "embed";
	source: string;
	target: string;
	targetKind: "note" | "attachment" | "unresolved" | "ambiguous";
	fragment?: string;
	suffix?: string;
	raw: string;
	line: number;
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
	async tagPages(identity: string): Promise<string[]> { return (await this.requireSnapshot()).tags[identity] ?? []; }
	async catalog(): Promise<MetadataTag[]> { return catalogFrom(await this.requireSnapshot()); }
	fileRevision(path: string, snapshot: MetadataSnapshot): string | undefined { return snapshot.files[path]?.revision; }
	async refresh(store: StoreConfig, signal?: AbortSignal): Promise<MetadataSnapshot> {
		throwIfAborted(signal);
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const notes: SafeNoteMetadata[] = [];
		await walkSafeNoteMetadata(store, (note) => { notes.push(note); }, signal);
		const files: string[] = [];
		const observed = new Map<string, { size: number; mtime: string; sourceRevision?: string }>();
		for (const note of notes) observed.set(note.note.path, { size: note.size, mtime: note.mtime });
		await walkSafeAttachmentPaths(store, async (path) => { const inspected = await safeInspectContainedFile(store, path, signal); observed.set(path, { size: inspected.size, mtime: inspected.mtime }); files.push(path); }, signal);
		const pages = notes.map((note) => note.note.path).sort();
		const byBase = new Map<string, string[]>();
		for (const path of [...pages, ...files]) {
			const base = basename(path);
			byBase.set(base, [...(byBase.get(base) ?? []), path]);
			if (base.endsWith(".md")) byBase.set(basename(base, ".md"), [...(byBase.get(basename(base, ".md")) ?? []), path]);
		}
		const edges: MetadataEdge[] = [];
		const tags = new Map<string, MetadataTag>();
		const diagnostics: string[] = [];
		for (const note of notes) {
			throwIfAborted(signal);
			const opened = await safeOpenNote(store, note.note.path, signal);
			const seen = observed.get(note.note.path);
			if (seen) observed.set(note.note.path, { ...seen, sourceRevision: opened.revision });
			const parsed = parseMarkdown(opened);
			if (parsed.frontmatter.error) diagnostics.push(`${note.note.path}: ${parsed.frontmatter.error}`);
			const rawTags = parsed.frontmatter.value?.tags;
			if (rawTags !== undefined && typeof rawTags !== "string" && !(Array.isArray(rawTags) && rawTags.every((item) => typeof item === "string"))) diagnostics.push(`${note.note.path}: invalid tag shape`);
			const spellings = typeof rawTags === "string" ? [rawTags] : Array.isArray(rawTags) && rawTags.every((item) => typeof item === "string") ? rawTags : [];
			for (const spelling of spellings) {
				const identity = tagIdentity(spelling);
				if (!identity) continue;
				const existing = tags.get(identity) ?? { identity, spelling, pages: [] };
				if (!existing.pages.includes(note.note.path)) existing.pages.push(note.note.path);
				tags.set(identity, existing);
			}
			for (const ref of extractWikilinks(opened.text, parsed.frontmatter.endLine ?? 0)) {
				edges.push({ ...resolveTarget(store, note.note.path, ref, pages, files, byBase), kind: ref.kind, source: note.note.path, fragment: ref.fragment, suffix: ref.suffix, raw: ref.raw, line: ref.line });
			}
		}
		await assertRootIdentity(store);
		const snapshot = publish(store, diagnostics, edges, tags, pages, files, observed);
		await atomicJson(join(this.root, "index.json"), snapshot);
		this.#snapshot = snapshot;
		return snapshot;
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

function publish(store: StoreConfig, diagnostics: string[], edges: MetadataEdge[], tags: Map<string, MetadataTag>, pages: string[], attachments: string[], observed: Map<string, { size: number; mtime: string; sourceRevision?: string }>): MetadataSnapshot {
	const files: Record<string, FileRecord> = {};
	const targets: Record<string, string[]> = {};
	const tagMembers: Record<string, string[]> = {};
	const references: Record<string, string[]> = {};
	const addTarget = (path: string) => { const stem = basename(path, extname(path)); targets[stem] = [...new Set([...(targets[stem] ?? []), path])]; };
	for (const path of [...pages, ...attachments]) addTarget(path);
	for (const path of pages) {
		const seen = observed.get(path);
		files[path] = { kind: "note", mtime: seen?.mtime ?? "", revision: seen?.sourceRevision, size: seen?.size, links: edges.filter((edge) => edge.source === path).map((edge) => ({ target: edge.target, kind: edge.kind, fragment: edge.fragment, suffix: edge.suffix, raw: edge.raw, line: edge.line, targetKind: edge.targetKind })), tags: [] };
	}
	for (const path of attachments) { const seen = observed.get(path); files[path] = { kind: "attachment", mtime: seen?.mtime ?? "", size: seen?.size }; }
	for (const tag of tags.values()) { tagMembers[tag.identity] = tag.pages; for (const page of tag.pages) if (files[page]?.kind === "note") files[page].tags = [...(files[page].tags ?? []), tag.spelling]; }
	for (const edge of edges) references[edge.target] = [...new Set([...(references[edge.target] ?? []), edge.source])];
	return { version: 2, revision: `meta-${randomBytes(16).toString("hex")}`, root: store.root, rootDev: store.rootDev, rootIno: store.rootIno, complete: diagnostics.length === 0, diagnostics, files, targets, tags: tagMembers, references };
}
function catalogFrom(snapshot: MetadataSnapshot): MetadataTag[] {
	return Object.entries(snapshot.tags).map(([identity, pages]) => ({ identity, spelling: pages.map((path) => snapshot.files[path]?.tags?.find((tag) => tagIdentity(tag) === identity)).find(Boolean) ?? identity, pages }));
}
function edgesFrom(snapshot: MetadataSnapshot, view: "links" | "backlinks", path: string): MetadataEdge[] {
	if (view === "links") return (snapshot.files[path]?.links ?? []).map((link) => ({ ...link, source: path, targetKind: link.targetKind ?? "unresolved" }));
	return (snapshot.references[path] ?? []).flatMap((source) => (snapshot.files[source]?.links ?? []).filter((link) => link.target === path).map((link) => ({ ...link, source, targetKind: snapshot.files[path]?.kind === "attachment" ? "attachment" as const : "note" as const })));
}
function resolveTarget(store: StoreConfig, source: string, ref: WikiReference, pages: string[], files: string[], byBase: Map<string, string[]>): Pick<MetadataEdge, "target" | "targetKind"> {
	const raw = ref.target;
	if (!raw && ref.fragment) return { target: source, targetKind: "note" };
	const withMd = raw.endsWith(".md") ? raw : `${raw}.md`;
	if (raw.includes("\\")) return { target: raw, targetKind: "unresolved" };
	const rooted = raw.includes("/");
	if (rooted) {
		const candidate = raw;
		if (candidate.split("/").includes("..")) return { target: raw, targetKind: "unresolved" };
		if (pages.includes(candidate) || pages.includes(withMd)) return { target: pages.includes(candidate) ? candidate : withMd, targetKind: "note" };
		if (files.includes(candidate)) return { target: candidate, targetKind: "attachment" };
		return { target: raw, targetKind: "unresolved" };
	}
	const matches = [...new Set(byBase.get(raw) ?? [])].filter((path) => pages.includes(path) || files.includes(path) || pages.includes(`${path}.md`));
	const noteMatches = pages.filter((path) => basename(path) === raw || basename(path) === withMd || basename(path, ".md") === raw);
	const fileMatches = files.filter((path) => basename(path) === raw);
	const all = [...new Set([...noteMatches, ...fileMatches])];
	if (all.length === 1) return { target: all[0], targetKind: extname(all[0]) === ".md" ? "note" : "attachment" };
	if (all.length > 1) return { target: raw, targetKind: "ambiguous" };
	void store; void matches;
	return { target: raw, targetKind: "unresolved" };
}

export function registerMetadata(coordinator: MaintenanceCoordinator, indexes: Map<string, MetadataIndex>, stores: ReadonlyMap<string, StoreConfig>): void {
	coordinator.register("metadata", async (job, signal) => {
		let revision = "";
		for (const name of job.stores) {
			const index = indexes.get(name);
			const store = stores.get(name);
			if (!index || !store) throw new DatastoreError("STORE_UNKNOWN");
			revision = (await index.refresh(store, signal)).revision;
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
