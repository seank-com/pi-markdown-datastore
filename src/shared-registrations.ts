import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { StoreConfig } from "./config.ts";
import { HARD_MAX_FILE_BYTES } from "./config-common.ts";
import { DatastoreError } from "./errors.ts";
import { inspectConfiguredRoot } from "./root-binding.ts";
import { definitionRevision, parseSharedJson, parseSharedSettings, readOwnedFile, type SharedHostSettings, type SharedHostState, type SharedStoreDefinition } from "./shared-config.ts";

export interface Declaration { root: string; include: string[]; exclude: string[] }
export interface DeclarationHostSettings extends SharedHostSettings {
	reader: Pick<StoreConfig, "maxFileBytes" | "search">;
}

const invalid = () => new DatastoreError("CONFIG_INVALID");
const object = (value: unknown, keys?: string[]): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value) || (keys && Object.keys(value).some(key => !keys.includes(key)))) throw invalid();
	return value as Record<string, unknown>;
};
const patterns = (value: unknown, fallback: string[]) => {
	if (value === undefined) return fallback;
	if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) throw invalid();
	return [...value] as string[];
};

export function parseDeclaration(input: unknown): Declaration {
	const raw = object(input, ["root", "include", "exclude"]);
	if (typeof raw.root !== "string" || !isAbsolute(raw.root) || raw.root.includes("\0")) throw invalid();
	const root = raw.root.replace(/\/+$/, "") || sep;
	if (resolve(root) !== root) throw invalid();
	const include = patterns(raw.include, ["**/*.md"]);
	if (include.length !== 1) throw invalid();
	return { root, include, exclude: patterns(raw.exclude, []) };
}

export const defaultHostConfigPath = () => join(homedir(), ".pi", "markdown-datastore", "host.json");
export function declarationId(root: string): string { return `s-${definitionRevision(root)}`; }

export async function loadDeclarationHostSettings(path = defaultHostConfigPath()): Promise<DeclarationHostSettings> {
	if (!isAbsolute(path) || await realpath(dirname(path)).catch(() => undefined) !== dirname(path)) throw invalid();
	const parent = await lstat(dirname(path));
	if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw invalid();
	const raw = object(parseSharedJson(await readOwnedFile(path)), ["schemaVersion", "socketPath", "stateRoot", "defaults", "qmd", "reader"]);
	const reader = object(raw.reader, ["maxFileBytes", "defaultMode"]);
	const maxFileBytes = reader.maxFileBytes;
	const defaultMode = reader.defaultMode;
	if (typeof maxFileBytes !== "number" || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > HARD_MAX_FILE_BYTES) throw invalid();
	if (defaultMode !== "lexical" && defaultMode !== "semantic" && defaultMode !== "hybrid") throw invalid();
	return { ...parseSharedSettings(path, raw), reader: { maxFileBytes, search: { defaultMode, qmdCollection: "notes" } } };
}

export function bindDeclaration(settings: DeclarationHostSettings, declaration: Declaration, identity: { rootDev: number; rootIno: number }): SharedStoreDefinition {
	const value = { id: declarationId(declaration.root), ...declaration, rootDev: identity.rootDev, rootIno: identity.rootIno, ...settings.reader };
	return { ...value, definitionRevision: definitionRevision({ ...value, qmd: settings.qmd }) };
}

const within = (parent: string, child: string) => child.startsWith(parent === sep ? sep : parent + sep);
function checkAdmission(roots: ReadonlyMap<string, Declaration>, candidate: Declaration): boolean {
	const same = roots.get(candidate.root);
	if (same) {
		const fields = (["include", "exclude"] as const).filter(key => candidate[key].length !== same[key].length || candidate[key].some((pattern, i) => pattern !== same[key][i]));
		if (fields.length) throw new DatastoreError("CONFIG_INVALID", { conflictingFields: fields });
		return false;
	}
	for (const root of roots.keys()) {
		if (within(root, candidate.root) || within(candidate.root, root)) throw new DatastoreError("CONFIG_INVALID", { conflictingFields: ["root"] });
		if (declarationId(root) === declarationId(candidate.root)) throw invalid();
	}
	return true;
}

async function publish(path: string, roots: ReadonlyMap<string, Declaration>): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	const registrations = Object.fromEntries([...roots].map(([root, { include, exclude }]) => [root, { include, exclude }]));
	try {
		await writeFile(temp, JSON.stringify({ schemaVersion: 1, registrations }), { mode: 0o600, flag: "wx" });
		await rename(temp, path);
	} catch (error) { await rm(temp, { force: true }); throw error; }
}

export async function loadRegistrations(settings: DeclarationHostSettings) {
	const path = join(dirname(settings.path), "registrations.json");
	const body = await readOwnedFile(path, false).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw invalid();
	});
	const roots = new Map<string, Declaration>();
	if (body !== undefined) {
		const raw = object(parseSharedJson(body), ["schemaVersion", "registrations"]);
		if (raw.schemaVersion !== 1) throw new DatastoreError("CONFIG_VERSION_UNSUPPORTED");
		for (const [root, patterns] of Object.entries(object(raw.registrations))) {
			const candidate = parseDeclaration({ ...object(patterns, ["include", "exclude"]), root });
			if (candidate.root !== root || !checkAdmission(roots, candidate)) throw invalid();
			roots.set(root, candidate);
		}
	}
	const stores = new Map<string, SharedStoreDefinition>();
	const unavailableStores = new Map<string, () => Promise<SharedStoreDefinition>>();
	const state: SharedHostState = { ...settings, stores, unavailableStores };
	const install = (declaration: Declaration) => {
		const id = declarationId(declaration.root);
		unavailableStores.set(id, async () => {
			const identity = await inspectConfiguredRoot(declaration.root);
			if (!identity) throw new DatastoreError("STORE_UNAVAILABLE", { sourceRoot: true });
			const existing = stores.get(id);
			if (existing) return existing;
			const definition = bindDeclaration(settings, declaration, identity);
			stores.set(id, definition);
			unavailableStores.delete(id);
			return definition;
		});
	};
	for (const declaration of roots.values()) {
		install(declaration);
		// A known but unavailable/unsafe source retains its reservation and can
		// be checked again on demand without disabling unrelated roots.
		await unavailableStores.get(declarationId(declaration.root))!().catch(error => {
			if (!(error instanceof DatastoreError)) throw error;
		});
	}
	let tail: Promise<unknown> = Promise.resolve();
	return {
		state,
		settled: () => tail,
		register(declaration: Declaration, expected: { rootDev: number; rootIno: number }): Promise<SharedStoreDefinition> {
			const operation = tail.then(async () => {
				const added = checkAdmission(roots, declaration);
				const identity = await inspectConfiguredRoot(declaration.root);
				if (!identity) throw new DatastoreError("STORE_UNAVAILABLE", { sourceRoot: true });
				const observed = bindDeclaration(settings, declaration, identity);
				const existing = stores.get(observed.id);
				if (expected.rootDev !== identity.rootDev || expected.rootIno !== identity.rootIno || (existing && existing.definitionRevision !== observed.definitionRevision)) throw new DatastoreError("STORE_UNAVAILABLE");
				if (added) {
					await publish(path, new Map(roots).set(declaration.root, declaration));
					roots.set(declaration.root, declaration);
				}
				stores.set(observed.id, existing ?? observed);
				unavailableStores.delete(observed.id);
				return existing ?? observed;
			});
			tail = operation.catch(() => undefined);
			return operation;
		},
	};
}
