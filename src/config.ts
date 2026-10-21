import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DatastoreError } from "./errors.ts";

export const HARD_MAX_RESULT_BYTES = 32 * 1024;
export const HARD_MAX_RESULT_LINES = 800;
export const HARD_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_SEARCH_RESULTS = 20;
export const HARD_MAX_CANDIDATES = 500;
export const HARD_MAX_OUTLINE = 100;

export interface DatastoreDefaults { maxResultBytes: number; maxResultLines: number; operationTimeoutMs: number }
export interface QmdConfig { enabled: boolean; installation: { executable?: string; packageRoot?: string }; minimumVersion: string }

export interface StoreConfig {
	name: string; configuredRoot: string; root: string; rootWasSymlink: boolean; rootDev: number; rootIno: number;
	include: string[]; exclude: string[]; maxFileBytes: number;
	search: { defaultMode: "lexical" | "semantic" | "hybrid"; qmdCollection: string };
}
export interface MarkdownDatastoreConfig {
	schemaVersion: 1; projectRoot: string; configPath: string; stateRoot: string; defaults: DatastoreDefaults;
	qmd: QmdConfig; stores: ReadonlyMap<string, StoreConfig>;
}

const TOP_KEYS = new Set(["schemaVersion", "defaults", "qmd", "stores"]);
const DEFAULT_KEYS = new Set(["maxResultBytes", "maxResultLines", "operationTimeoutMs"]);
const QMD_KEYS = new Set(["enabled", "installation", "minimumVersion"]);
const INSTALL_KEYS = new Set(["executable", "packageRoot"]);
const STORE_KEYS = new Set(["root", "include", "exclude", "maxFileBytes", "search"]);
const SEARCH_KEYS = new Set(["defaultMode", "qmdCollection"]);
const STORE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DatastoreError("CONFIG_INVALID");
	return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: Set<string>): void {
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new DatastoreError("CONFIG_INVALID");
}
function string(value: unknown, nonempty = true): string {
	if (typeof value !== "string" || (nonempty && value.length === 0)) throw new DatastoreError("CONFIG_INVALID");
	return value;
}
function bool(value: unknown): boolean {
	if (typeof value !== "boolean") throw new DatastoreError("CONFIG_INVALID");
	return value;
}
function integer(value: unknown, min: number, max: number): number {
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new DatastoreError("CONFIG_INVALID");
	return value as number;
}
function stringArray(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new DatastoreError("CONFIG_INVALID");
	return [...value];
}

/** Strict JSON duplicate-key pass. JSON.parse alone silently accepts the last duplicate. */
export function assertNoDuplicateJsonKeys(text: string): void {
	let index = 0;
	const ws = () => { while (/\s/.test(text[index] ?? "")) index += 1; };
	const quoted = (): string => {
		const start = index;
		if (text[index++] !== '"') throw new DatastoreError("CONFIG_INVALID");
		let escaped = false;
		while (index < text.length) {
			const char = text[index++];
			if (!escaped && char === '"') {
				try { return JSON.parse(text.slice(start, index)); } catch { throw new DatastoreError("CONFIG_INVALID"); }
			}
			if (!escaped && char === "\\") escaped = true; else escaped = false;
		}
		throw new DatastoreError("CONFIG_INVALID");
	};
	const value = (): void => {
		ws();
		if (text[index] === "{") object();
		else if (text[index] === "[") array();
		else if (text[index] === '"') void quoted();
		else {
			const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
			if (!match) throw new DatastoreError("CONFIG_INVALID");
			index += match[0].length;
		}
	};
	const object = (): void => {
		index += 1; ws(); const keys = new Set<string>();
		if (text[index] === "}") { index += 1; return; }
		for (;;) {
			ws(); const key = quoted();
			if (keys.has(key)) throw new DatastoreError("CONFIG_INVALID");
			keys.add(key); ws(); if (text[index++] !== ":") throw new DatastoreError("CONFIG_INVALID");
			value(); ws(); const delimiter = text[index++];
			if (delimiter === "}") return;
			if (delimiter !== ",") throw new DatastoreError("CONFIG_INVALID");
		}
	};
	const array = (): void => {
		index += 1; ws(); if (text[index] === "]") { index += 1; return; }
		for (;;) { value(); ws(); const delimiter = text[index++]; if (delimiter === "]") return; if (delimiter !== ",") throw new DatastoreError("CONFIG_INVALID"); }
	};
	value(); ws(); if (index !== text.length) throw new DatastoreError("CONFIG_INVALID");
}

async function assertProtectedDirectory(path: string): Promise<void> {
	const info = await lstat(path).catch(() => { throw new DatastoreError("CONFIG_INVALID"); });
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new DatastoreError("CONFIG_INVALID");
	const parent = resolve(path, "..");
	const rel = relative(parent, path);
	if (!rel || rel.startsWith(`..${sep}`)) throw new DatastoreError("CONFIG_INVALID");
}

async function assertConfigAuthorityPath(projectRoot: string, configPath: string): Promise<void> {
	const expected = projectDatastoreConfigPath(projectRoot);
	if (configPath !== expected) throw new DatastoreError("CONFIG_INVALID");
	const parent = resolve(configPath, "..");
	const rel = relative(projectRoot, parent);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new DatastoreError("CONFIG_INVALID");
	let current = projectRoot;
	const components = ["", ...rel.split(sep)];
	for (let index = 0; index < components.length; index += 1) {
		if (components[index]) current = join(current, components[index]);
		const info = await lstat(current).catch(() => { throw new DatastoreError("CONFIG_INVALID"); });
		const final = index === components.length - 1;
		if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & (final ? 0o077 : 0o022)) !== 0) throw new DatastoreError("CONFIG_INVALID");
	}
}

async function readProtectedConfig(path: string): Promise<string> {
	await assertProtectedDirectory(resolve(path, ".."));
	const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new DatastoreError("CONFIG_MISSING");
		throw new DatastoreError("CONFIG_INVALID");
	});
	if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > 64 * 1024) throw new DatastoreError("CONFIG_INVALID");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await handle.stat();
		if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size > 64 * 1024) throw new DatastoreError("CONFIG_INVALID");
		const bytes = Buffer.alloc(current.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (read.bytesRead === 0) break;
			offset += read.bytesRead;
		}
		if (offset !== bytes.length) throw new DatastoreError("CONFIG_INVALID");
		try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new DatastoreError("CONFIG_INVALID"); }
	} finally { await handle.close(); }
}

export function projectDatastoreConfigPath(projectRoot: string): string {
	return join(resolve(projectRoot), CONFIG_DIR_NAME, "markdown-datastore", "config.json");
}

export async function loadMarkdownDatastoreConfig(projectRootInput: string, configPathInput?: string): Promise<MarkdownDatastoreConfig> {
	const projectRoot = await realpath(resolve(projectRootInput));
	const requestedConfigPath = resolve(configPathInput ?? projectDatastoreConfigPath(projectRoot));
	const configParent = await realpath(resolve(requestedConfigPath, "..")).catch(() => { throw new DatastoreError("CONFIG_MISSING"); });
	const configPath = join(configParent, basename(requestedConfigPath));
	await assertConfigAuthorityPath(projectRoot, configPath);
	const text = await readProtectedConfig(configPath);
	assertNoDuplicateJsonKeys(text);
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { throw new DatastoreError("CONFIG_INVALID"); }
	const top = record(raw); exactKeys(top, TOP_KEYS);
	if (top.schemaVersion !== 1) throw new DatastoreError("CONFIG_VERSION_UNSUPPORTED");

	const defaultsRaw = record(top.defaults); exactKeys(defaultsRaw, DEFAULT_KEYS);
	const defaults: DatastoreDefaults = {
		maxResultBytes: integer(defaultsRaw.maxResultBytes, 1, HARD_MAX_RESULT_BYTES),
		maxResultLines: integer(defaultsRaw.maxResultLines, 1, HARD_MAX_RESULT_LINES),
		operationTimeoutMs: integer(defaultsRaw.operationTimeoutMs, 100, 60_000),
	};
	const qmdRaw = record(top.qmd); exactKeys(qmdRaw, QMD_KEYS);
	const installationRaw = record(qmdRaw.installation); exactKeys(installationRaw, INSTALL_KEYS);
	const executable = installationRaw.executable === undefined ? undefined : string(installationRaw.executable);
	const packageRoot = installationRaw.packageRoot === undefined ? undefined : string(installationRaw.packageRoot);
	if ((executable === undefined) === (packageRoot === undefined) || (packageRoot !== undefined && !isAbsolute(packageRoot))) throw new DatastoreError("CONFIG_INVALID");
	const qmd: QmdConfig = { enabled: bool(qmdRaw.enabled), installation: { executable, packageRoot }, minimumVersion: string(qmdRaw.minimumVersion) };

	const storesRaw = record(top.stores);
	if (Object.keys(storesRaw).length === 0) throw new DatastoreError("CONFIG_INVALID");
	const stores = new Map<string, StoreConfig>();
	const qmdCollections = new Set<string>();
	const canonicalRoots = new Set<string>();
	for (const [name, value] of Object.entries(storesRaw)) {
		if (!STORE_NAME.test(name)) throw new DatastoreError("CONFIG_INVALID");
		const storeRaw = record(value); exactKeys(storeRaw, STORE_KEYS);
		const configuredRoot = string(storeRaw.root);
		const rootInput = isAbsolute(configuredRoot) ? configuredRoot : resolve(projectRoot, configuredRoot);
		const rootLstat = await lstat(rootInput).catch(() => { throw new DatastoreError("CONFIG_INVALID"); });
		const root = await realpath(rootInput).catch(() => { throw new DatastoreError("CONFIG_INVALID"); });
		if (rootLstat.isSymbolicLink() || root !== resolve(rootInput)) throw new DatastoreError("SYMLINK_REJECTED");
		const rootStat = await stat(root).catch(() => { throw new DatastoreError("CONFIG_INVALID"); });
		if (!rootStat.isDirectory() || canonicalRoots.has(root)) throw new DatastoreError("CONFIG_INVALID");
		canonicalRoots.add(root);
		const searchRaw = record(storeRaw.search); exactKeys(searchRaw, SEARCH_KEYS);
		const defaultMode = string(searchRaw.defaultMode) as StoreConfig["search"]["defaultMode"];
		const qmdCollection = string(searchRaw.qmdCollection);
		if (!["lexical", "semantic", "hybrid"].includes(defaultMode) || !STORE_NAME.test(qmdCollection) || qmdCollections.has(qmdCollection)) throw new DatastoreError("CONFIG_INVALID");
		qmdCollections.add(qmdCollection);
		const include = storeRaw.include === undefined ? ["**/*.md"] : stringArray(storeRaw.include);
		if (qmd.enabled && include.length !== 1) throw new DatastoreError("CONFIG_INVALID");
		stores.set(name, {
			name, configuredRoot, root, rootWasSymlink: rootLstat.isSymbolicLink(), rootDev: rootStat.dev, rootIno: rootStat.ino,
			include,
			exclude: storeRaw.exclude === undefined ? [".git/**", `${CONFIG_DIR_NAME}/**`] : stringArray(storeRaw.exclude),
			maxFileBytes: integer(storeRaw.maxFileBytes, 1, HARD_MAX_FILE_BYTES),
			search: { defaultMode, qmdCollection },
		});
	}
	return { schemaVersion: 1, projectRoot, configPath, stateRoot: resolve(configPath, "..", "state"), defaults, qmd, stores };
}
