import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { StoreConfig } from "./config.ts";
import { safeInspectContainedFile, safeOpenNote, walkSafeAttachmentPaths, walkSafeNoteMetadata, type SafeNoteMetadata } from "./containment.ts";
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
export interface MetadataSnapshot {
	version: 1;
	revision: string;
	complete: boolean;
	diagnostics: string[];
	edges: MetadataEdge[];
	tags: MetadataTag[];
	pages: string[];
	files: string[];
}

async function atomicJson(path: string, value: unknown): Promise<void> {
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
			if (saved.version !== 1 || typeof saved.revision !== "string") throw new DatastoreError("INDEX_CORRUPT");
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
	async links(path: string): Promise<MetadataEdge[]> { return (await this.requireSnapshot()).edges.filter((edge) => edge.source === path); }
	async backlinks(path: string): Promise<MetadataEdge[]> { return (await this.requireSnapshot()).edges.filter((edge) => edge.target === path && edge.targetKind !== "unresolved" && edge.targetKind !== "ambiguous"); }
	async tagPages(identity: string): Promise<string[]> { return (await this.requireSnapshot()).tags.find((tag) => tag.identity === identity)?.pages ?? []; }
	async catalog(): Promise<MetadataTag[]> { return (await this.requireSnapshot()).tags; }
	async refresh(store: StoreConfig, signal?: AbortSignal): Promise<MetadataSnapshot> {
		throwIfAborted(signal);
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const notes: SafeNoteMetadata[] = [];
		await walkSafeNoteMetadata(store, (note) => { notes.push(note); }, signal);
		const files: string[] = [];
		await walkSafeAttachmentPaths(store, async (path) => { await safeInspectContainedFile(store, path, signal); files.push(path); }, signal);
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
			const parsed = parseMarkdown(opened);
			if (parsed.frontmatter.error) diagnostics.push(`${note.note.path}: ${parsed.frontmatter.error}`);
			const rawTags = parsed.frontmatter.value?.tags;
			if (rawTags !== undefined && typeof rawTags !== "string" && !(Array.isArray(rawTags) && rawTags.every((item) => typeof item === "string"))) diagnostics.push(`${note.note.path}: invalid tag shape`);
			for (const spelling of parsed.frontmatter.tags) {
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
		const snapshot: MetadataSnapshot = { version: 1, revision: `meta-${randomBytes(16).toString("hex")}`, complete: diagnostics.length === 0, diagnostics, edges, tags: [...tags.values()].sort((a, b) => a.identity.localeCompare(b.identity)), pages, files: files.sort() };
		await atomicJson(join(this.root, "index.json"), snapshot);
		this.#snapshot = snapshot;
		return snapshot;
	}
	async shutdown(): Promise<void> { this.#snapshot = undefined; }
}

function resolveTarget(store: StoreConfig, source: string, ref: WikiReference, pages: string[], files: string[], byBase: Map<string, string[]>): Pick<MetadataEdge, "target" | "targetKind"> {
	const raw = ref.target;
	if (!raw && ref.fragment) return { target: source, targetKind: "note" };
	const withMd = raw.endsWith(".md") ? raw : `${raw}.md`;
	const rooted = raw.includes("/") || raw.includes("\\");
	if (rooted) {
		const candidate = raw.replaceAll("\\", "/");
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

export function pageItems<T>(items: T[], offset: number, budget: { maxBytes: number; maxLines: number }): { items: T[]; next?: number } {
	const selected: T[] = [];
	let index = offset;
	for (; index < items.length; index += 1) {
		const candidate = [...selected, items[index]];
		const text = JSON.stringify(candidate);
		if (selected.length > 0 && (Buffer.byteLength(text) > budget.maxBytes || candidate.length + 1 > budget.maxLines)) break;
		selected.push(items[index]);
	}
	return { items: selected, next: index < items.length ? index : undefined };
}
