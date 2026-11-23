import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { QmdConfig, StoreConfig } from "./config.ts";
import { assertNoDuplicateJsonKeys } from "./config-common.ts";
import { DatastoreError } from "./errors.ts";
import { isRootUnavailable } from "./root-binding.ts";

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

export interface SharedHostState extends SharedHostSettings {
	stores: ReadonlyMap<string, SharedStoreDefinition>;
	unavailableStores: ReadonlyMap<string, () => Promise<SharedStoreDefinition>>;
}

const DEFAULTS = new Set(["maxResultBytes", "maxResultLines", "operationTimeoutMs"]);
const QMD = new Set(["enabled", "installation", "minimumVersion"]);
const INSTALL = new Set(["executable", "packageRoot"]);

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
