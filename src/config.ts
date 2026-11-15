import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DatastoreError } from "./errors.ts";
import { definitionRevision, loadSharedCatalog } from "./shared-catalog.ts";
import { inspectConfiguredRoot, provisionSharedStore } from "./root-binding.ts";

import { assertNoDuplicateJsonKeys, HARD_MAX_FILE_BYTES } from "./config-common.ts";
export { assertNoDuplicateJsonKeys, clampReadBudget, exceedsBudget, HARD_MAX_CANDIDATES, HARD_MAX_FILE_BYTES, HARD_MAX_OUTLINE, HARD_MAX_SEARCH_RESULTS, resolveResultBudget } from "./config-common.ts";
export type { ResultBudget } from "./config-common.ts";

export interface DatastoreDefaults { maxResultBytes?: number; maxResultLines?: number; operationTimeoutMs: number }
export interface QmdConfig { enabled: boolean; installation: { executable?: string; packageRoot?: string }; minimumVersion: string }

export interface SharedStoreReference { catalog: string; store: string; socketPath: string; definitionRevision: string }
export interface StoreConfig {
	name: string; configuredRoot: string; root: string; rootWasSymlink: boolean; rootDev: number; rootIno: number;
	include: string[]; exclude: string[]; maxFileBytes: number;
	search: { defaultMode: "lexical" | "semantic" | "hybrid"; qmdCollection: string };
	shared?: SharedStoreReference;
}
export interface MarkdownDatastoreConfig {
	schemaVersion: 1; projectRoot: string; configPath: string; stateRoot: string; defaults: DatastoreDefaults;
	qmd: QmdConfig; stores: ReadonlyMap<string, StoreConfig>;
	unavailableStores?: ReadonlyMap<string, () => Promise<StoreConfig>>;
	readonly structuralError?: DatastoreError;
	privateStoreNames?: ReadonlySet<string>;
}

const TOP_KEYS = new Set(["schemaVersion", "defaults", "qmd", "stores"]);
const DEFAULT_KEYS = new Set(["maxResultBytes", "maxResultLines", "operationTimeoutMs"]);
const QMD_KEYS = new Set(["enabled", "installation", "minimumVersion"]);
const INSTALL_KEYS = new Set(["executable", "packageRoot"]);
const STORE_KEYS = new Set(["root", "include", "exclude", "maxFileBytes", "search"]);
const SHARED_STORE_KEYS = new Set(["shared"]);
const SHARED_REF_KEYS = new Set(["catalog", "store"]);
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
function optionalBudget(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DatastoreError("CONFIG_INVALID");
	return value as number;
}
function stringArray(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new DatastoreError("CONFIG_INVALID");
	return [...value];
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
		maxResultBytes: optionalBudget(defaultsRaw.maxResultBytes),
		maxResultLines: optionalBudget(defaultsRaw.maxResultLines),
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
	const unavailableStores = new Map<string, () => Promise<StoreConfig>>();
	let structuralError: DatastoreError | undefined;
	const catalogs = new Map<string, Promise<Awaited<ReturnType<typeof loadSharedCatalog>>>>();
	const catalogFor = async (path: string) => {
		let pending = catalogs.get(path);
		if (!pending) { pending = loadSharedCatalog(path); catalogs.set(path, pending); }
		try { return await pending; } catch (error) {
			if (catalogs.get(path) === pending) catalogs.delete(path);
			if (error instanceof DatastoreError && error.code !== "STORE_UNAVAILABLE") structuralError = error;
			throw error;
		}
	};
	const privateStoreNames = new Set<string>();
	const qmdCollections = new Set<string>();
	const canonicalRoots = new Set<string>();
	for (const [name, value] of Object.entries(storesRaw)) {
		if (!STORE_NAME.test(name)) throw new DatastoreError("CONFIG_INVALID");
		const storeRaw = record(value);
		if (Object.hasOwn(storeRaw, "shared")) {
			exactKeys(storeRaw, SHARED_STORE_KEYS);
			const sharedRaw = record(storeRaw.shared); exactKeys(sharedRaw, SHARED_REF_KEYS);
			const catalogPath = string(sharedRaw.catalog);
			const sharedId = string(sharedRaw.store);
			if (!isAbsolute(catalogPath) || !STORE_NAME.test(sharedId)) throw new DatastoreError("CONFIG_INVALID");
			const bind = async (): Promise<StoreConfig> => {
				const existing = stores.get(name); if (existing) return existing;
				const catalog = await catalogFor(catalogPath);
				const defined = catalog.stores.get(sharedId) ?? await catalog.unavailableStores.get(sharedId)?.();
				if (!defined) { structuralError = new DatastoreError("CONFIG_INVALID"); throw structuralError; }
				const observed = await inspectConfiguredRoot(defined.root).catch(() => { throw new DatastoreError("STORE_UNAVAILABLE"); });
				if (!observed) throw new DatastoreError("STORE_UNAVAILABLE");
				const revision = definitionRevision({ id: sharedId, ...observed, include: defined.include, exclude: defined.exclude, maxFileBytes: defined.maxFileBytes, search: defined.search, qmd: catalog.qmd });
				const store: StoreConfig = {
					name, configuredRoot: observed.root, root: observed.root, rootWasSymlink: false, rootDev: observed.rootDev, rootIno: observed.rootIno,
					include: defined.include, exclude: defined.exclude, maxFileBytes: defined.maxFileBytes, search: defined.search,
					shared: { catalog: catalog.path, store: sharedId, socketPath: catalog.socketPath, definitionRevision: revision },
				};
				provisionSharedStore(store, () => { if (stores.get(name) === store) stores.delete(name); });
				stores.set(name, store); return store;
			};
			unavailableStores.set(name, bind);
			try { await bind(); } catch (error) { if (!(error instanceof DatastoreError) || error.code !== "STORE_UNAVAILABLE") throw error; }
			continue;
		}
		exactKeys(storeRaw, STORE_KEYS);
		privateStoreNames.add(name);
		const configuredRoot = string(storeRaw.root);
		const rootInput = isAbsolute(configuredRoot) ? configuredRoot : resolve(projectRoot, configuredRoot);
		const captured = await inspectConfiguredRoot(rootInput, "SYMLINK_REJECTED");
		if (captured && canonicalRoots.has(captured.root)) throw new DatastoreError("CONFIG_INVALID");
		if (captured) canonicalRoots.add(captured.root);
		const searchRaw = record(storeRaw.search); exactKeys(searchRaw, SEARCH_KEYS);
		const defaultMode = string(searchRaw.defaultMode) as StoreConfig["search"]["defaultMode"];
		const qmdCollection = string(searchRaw.qmdCollection);
		if (!["lexical", "semantic", "hybrid"].includes(defaultMode) || !STORE_NAME.test(qmdCollection) || qmdCollections.has(qmdCollection)) throw new DatastoreError("CONFIG_INVALID");
		qmdCollections.add(qmdCollection);
		const include = storeRaw.include === undefined ? ["**/*.md"] : stringArray(storeRaw.include);
		if (qmd.enabled && include.length !== 1) throw new DatastoreError("CONFIG_INVALID");
		const settings = { name, configuredRoot, rootWasSymlink: false, include,
			exclude: storeRaw.exclude === undefined ? [".git/**", `${CONFIG_DIR_NAME}/**`] : stringArray(storeRaw.exclude),
			maxFileBytes: integer(storeRaw.maxFileBytes, 1, HARD_MAX_FILE_BYTES), search: { defaultMode, qmdCollection } };
		const storeFor = (identity: { root: string; rootDev: number; rootIno: number }): StoreConfig => ({
			name, configuredRoot, root: identity.root, rootWasSymlink: false, rootDev: identity.rootDev, rootIno: identity.rootIno,
			include: settings.include, exclude: settings.exclude, maxFileBytes: settings.maxFileBytes, search: settings.search,
		});
		if (captured) stores.set(name, storeFor(captured));
		else unavailableStores.set(name, async () => {
			const existing = stores.get(name); if (existing) return existing;
			const identity = await inspectConfiguredRoot(rootInput, "SYMLINK_REJECTED").catch(() => { throw new DatastoreError("STORE_UNAVAILABLE"); });
			if (!identity || canonicalRoots.has(identity.root)) throw new DatastoreError("STORE_UNAVAILABLE");
			canonicalRoots.add(identity.root);
			const store = storeFor(identity); stores.set(name, store); return store;
		});
	}
	return { schemaVersion: 1, projectRoot, configPath, stateRoot: resolve(configPath, "..", "state"), defaults, qmd, stores, unavailableStores, privateStoreNames, get structuralError() { return structuralError; } };
}

export function configuredStoreNames(config: MarkdownDatastoreConfig): string[] {
	return [...new Set([...config.stores.keys(), ...(config.unavailableStores?.keys() ?? [])])];
}
const pendingBindings = new WeakMap<MarkdownDatastoreConfig, Map<string, Promise<StoreConfig>>>();
export async function resolveConfiguredStore(config: MarkdownDatastoreConfig, name: string): Promise<StoreConfig> {
	if (config.structuralError) throw config.structuralError;
	const existing = config.stores.get(name); if (existing) return existing;
	const bind = config.unavailableStores?.get(name);
	if (!bind) throw new DatastoreError("STORE_UNKNOWN", { store: name });
	const pending = pendingBindings.get(config) ?? new Map<string, Promise<StoreConfig>>();
	pendingBindings.set(config, pending);
	const current = pending.get(name); if (current) return current;
	const operation = bind(); pending.set(name, operation);
	try { return await operation; } finally { pending.delete(name); }
}
