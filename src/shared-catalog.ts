import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { QmdConfig, StoreConfig } from "./config.ts";
import { assertNoDuplicateJsonKeys } from "./config-common.ts";
import { DatastoreError } from "./errors.ts";
import { inspectConfiguredRoot, isRootUnavailable } from "./root-binding.ts";

export interface SharedStoreDefinition {
	id: string;
	root: string;
	rootDev: number;
	rootIno: number;
	include: string[];
	exclude: string[];
	maxFileBytes: number;
	search: StoreConfig["search"];
	definitionRevision: string;
}

export interface SharedHostSettings {
	path: string;
	socketPath: string;
	stateRoot: string;
	defaults: { maxResultBytes?: number; maxResultLines?: number; operationTimeoutMs: number };
	qmd: QmdConfig;
}

export interface SharedCatalog extends SharedHostSettings {
	stores: ReadonlyMap<string, SharedStoreDefinition>;
	unavailableStores: ReadonlyMap<string, () => Promise<SharedStoreDefinition>>;
}

const TOP = new Set(["schemaVersion", "socketPath", "stateRoot", "defaults", "qmd", "stores"]);
const DEFAULTS = new Set(["maxResultBytes", "maxResultLines", "operationTimeoutMs"]);
const QMD = new Set(["enabled", "installation", "minimumVersion"]);
const INSTALL = new Set(["executable", "packageRoot"]);
const STORE = new Set(["root", "include", "exclude", "maxFileBytes", "search"]);
const SEARCH = new Set(["defaultMode", "qmdCollection"]);
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DatastoreError("CONFIG_INVALID");
	return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: Set<string>): void {
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new DatastoreError("CONFIG_INVALID");
}
function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new DatastoreError("CONFIG_INVALID");
	return value;
}
function integer(value: unknown, min: number, max: number): number {
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new DatastoreError("CONFIG_INVALID");
	return value as number;
}

export async function readOwnedBytes(path: string, configuration = true): Promise<Buffer> {
	const before = await lstat(path).catch((error) => { if (configuration && isRootUnavailable(error)) throw new DatastoreError("STORE_UNAVAILABLE"); throw error; });
	if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || (configuration && before.size > 64 * 1024)) throw new DatastoreError("CONFIG_INVALID");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await handle.stat();
		if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || (configuration && current.size > 64 * 1024)) throw new DatastoreError("CONFIG_INVALID");
		const bytes = Buffer.alloc(current.size);
		let offset = 0;
		while (offset < bytes.length) {
			const read = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (read.bytesRead === 0) break;
			offset += read.bytesRead;
		}
		if (offset !== bytes.length) throw new DatastoreError("CONFIG_INVALID");
		return bytes;
	} finally { await handle.close(); }
}

export async function readOwnedFile(path: string, configuration = true): Promise<string> {
	const bytes = await readOwnedBytes(path, configuration);
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new DatastoreError("CONFIG_INVALID"); }
}

export function definitionRevision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function loadSharedCatalog(pathInput: string): Promise<SharedCatalog> {
	try { return await parseSharedCatalog(pathInput); }
	catch (error) {
		if (error instanceof DatastoreError) throw error;
		throw new DatastoreError(isRootUnavailable(error) ? "STORE_UNAVAILABLE" : "CONFIG_INVALID");
	}
}
async function parseSharedCatalog(pathInput: string): Promise<SharedCatalog> {
	if (!isAbsolute(pathInput)) throw new DatastoreError("CONFIG_INVALID");
	const path = await realpath(pathInput).catch((error) => { if (isRootUnavailable(error)) throw new DatastoreError("STORE_UNAVAILABLE"); throw new DatastoreError("CONFIG_INVALID"); });
	const top = parseSharedJson(await readOwnedFile(path)); exact(top, TOP);
	const settings = parseSharedSettings(path, top);
	const { qmd } = settings;
	const storesRaw = record(top.stores);
	return bindCatalog(settings, storesRaw);
}

export function parseSharedJson(body: string): Record<string, unknown> {
	assertNoDuplicateJsonKeys(body);
	try { return record(JSON.parse(body)); } catch { throw new DatastoreError("CONFIG_INVALID"); }
}

export function parseSharedSettings(path: string, top: Record<string, unknown>): SharedHostSettings {
	if (top.schemaVersion !== 1) throw new DatastoreError("CONFIG_VERSION_UNSUPPORTED");
	const socketPath = text(top.socketPath);
	const stateRoot = text(top.stateRoot);
	if (!isAbsolute(socketPath) || !isAbsolute(stateRoot)) throw new DatastoreError("CONFIG_INVALID");
	const defaultsRaw = record(top.defaults); exact(defaultsRaw, DEFAULTS);
	const defaults = {
		maxResultBytes: defaultsRaw.maxResultBytes === undefined ? undefined : integer(defaultsRaw.maxResultBytes, 1, Number.MAX_SAFE_INTEGER),
		maxResultLines: defaultsRaw.maxResultLines === undefined ? undefined : integer(defaultsRaw.maxResultLines, 1, Number.MAX_SAFE_INTEGER),
		operationTimeoutMs: integer(defaultsRaw.operationTimeoutMs, 100, 60_000),
	};
	const qmdRaw = record(top.qmd); exact(qmdRaw, QMD);
	const installationRaw = record(qmdRaw.installation); exact(installationRaw, INSTALL);
	const executable = installationRaw.executable === undefined ? undefined : text(installationRaw.executable);
	const packageRoot = installationRaw.packageRoot === undefined ? undefined : text(installationRaw.packageRoot);
	if ((executable === undefined) === (packageRoot === undefined) || (packageRoot !== undefined && !isAbsolute(packageRoot))) throw new DatastoreError("CONFIG_INVALID");
	if (typeof qmdRaw.enabled !== "boolean") throw new DatastoreError("CONFIG_INVALID");
	const qmd: QmdConfig = { enabled: qmdRaw.enabled, installation: { executable, packageRoot }, minimumVersion: text(qmdRaw.minimumVersion) };
	return { path, socketPath, stateRoot, defaults, qmd };
}

async function bindCatalog(settings: SharedHostSettings, storesRaw: Record<string, unknown>): Promise<SharedCatalog> {
	const { qmd } = settings;
	if (Object.keys(storesRaw).length === 0) throw new DatastoreError("CONFIG_INVALID");
	const stores = new Map<string, SharedStoreDefinition>();
	const unavailableStores = new Map<string, () => Promise<SharedStoreDefinition>>();
	for (const [id, value] of Object.entries(storesRaw)) {
		if (!NAME.test(id)) throw new DatastoreError("CONFIG_INVALID");
		const storeRaw = record(value); exact(storeRaw, STORE);
		const configuredRoot = text(storeRaw.root);
		if (!isAbsolute(configuredRoot)) throw new DatastoreError("CONFIG_INVALID");
		const captured = await inspectConfiguredRoot(configuredRoot);
		const searchRaw = record(storeRaw.search); exact(searchRaw, SEARCH);
		const defaultMode = text(searchRaw.defaultMode) as StoreConfig["search"]["defaultMode"];
		const qmdCollection = text(searchRaw.qmdCollection);
		if (!["lexical", "semantic", "hybrid"].includes(defaultMode) || !NAME.test(qmdCollection)) throw new DatastoreError("CONFIG_INVALID");
		const include = storeRaw.include === undefined ? ["**/*.md"] : (Array.isArray(storeRaw.include) ? storeRaw.include.map(text) : (() => { throw new DatastoreError("CONFIG_INVALID"); })());
		if (include.length !== 1) throw new DatastoreError("CONFIG_INVALID");
		const exclude = storeRaw.exclude === undefined ? [] : (Array.isArray(storeRaw.exclude) ? storeRaw.exclude.map(text) : (() => { throw new DatastoreError("CONFIG_INVALID"); })());
		const maxFileBytes = integer(storeRaw.maxFileBytes, 1, 10 * 1024 * 1024);
		const bind = async (identity = captured): Promise<SharedStoreDefinition> => {
			const existing = stores.get(id);
			if (existing) return existing;
			identity ??= await inspectConfiguredRoot(configuredRoot).catch(() => { throw new DatastoreError("STORE_UNAVAILABLE"); });
			if (!identity) throw new DatastoreError("STORE_UNAVAILABLE");
			const bound = stores.get(id); if (bound) return bound;
			const value = { id, ...identity, include, exclude, maxFileBytes, search: { defaultMode, qmdCollection } };
			const defined = { ...value, definitionRevision: definitionRevision({ ...value, qmd }) };
			stores.set(id, defined);
			return defined;
		};
		if (captured) await bind();
		else unavailableStores.set(id, () => bind());
	}
	return { ...settings, stores, unavailableStores };
}
