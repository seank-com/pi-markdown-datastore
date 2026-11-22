import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DatastoreError } from "./errors.ts";
import { acquireIndexOwnership, type IndexOwnership } from "./index-ownership.ts";
import { MaintenanceCoordinator, sourceDefinition } from "./maintenance-coordinator.ts";
import { qmdApplicationDirectory } from "./qmd-adapter.ts";
import { parseSharedJson, readOwnedBytes, loadSharedCatalog } from "./shared-catalog.ts";
import { sharedStoreConfig } from "./shared-host.ts";
import { declarationId, parseDeclaration } from "./shared-registrations.ts";

const fail = (reason: string) => new DatastoreError("STORE_UNAVAILABLE", { reason }, reason);
const exists = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
const inside = (parent: string, child: string) => parent === child || child.startsWith(parent === sep ? sep : parent + sep);

async function protectedDir(path: string) {
	const info = await lstat(path);
	if (await realpath(path) !== path || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw fail("Unsafe state directory");
}

/** Prepare an inert bundle; never install files or initialize a queue. */
export async function prepareSharedCutover(catalogPath: string, output: string, newStateRoot: string): Promise<void> {
	for (const path of [catalogPath, output, newStateRoot]) {
		if (!isAbsolute(path) || resolve(path) !== path || await realpath(dirname(path)) !== dirname(path)) throw fail("Expected canonical absolute paths with existing parents");
	}
	const original = await readOwnedBytes(catalogPath);
	const catalog = await loadSharedCatalog(catalogPath);
	if (catalog.unavailableStores.size) throw fail("A legacy source cannot be verified");
	const members = [...catalog.stores.values()];
	const roots = members.map(member => member.root);
	if (roots.some((root, i) => roots.some((other, j) => i !== j && inside(root, other))) || new Set(roots.map(declarationId)).size !== roots.length) throw fail("Conflicting legacy roots");
	if (inside(output, newStateRoot) || inside(newStateRoot, output) || [catalog.stateRoot, ...roots].some(root => [output, newStateRoot].some(path => inside(root, path) || inside(path, root)))) throw fail("Bundle and new state must be separate from sources and old state");
	if (await exists(output) || await exists(newStateRoot)) throw fail("Bundle and new state paths must not exist");
	const reader = { maxFileBytes: members[0].maxFileBytes, defaultMode: members[0].search.defaultMode };
	if (members.some(member => member.maxFileBytes !== reader.maxFileBytes || member.search.defaultMode !== reader.defaultMode)) throw fail("Legacy reader policies differ; one declaration host policy cannot preserve them");
	await protectedDir(catalog.stateRoot);
	const knownIds = new Set(members.map(member => member.id));
	if ((await readdir(catalog.stateRoot)).some(name => !knownIds.has(name))) throw fail("Unrecognized entries in legacy state root");
	const leases: IndexOwnership[] = [];
	let scratch: string | undefined;
	let created = false;
	try {
		for (const member of members) {
			const directory = join(catalog.stateRoot, member.id);
			await protectedDir(directory);
			leases.push(await acquireIndexOwnership(directory));
		}
		scratch = await mkdtemp(join(dirname(output), ".shared-cutover-"));
		const histories: { path: string; archive: string; sha256: string; jobs: number }[] = [];
		for (const member of members) {
			const config = sharedStoreConfig(catalog, member);
			const store = config.stores.get(member.id)!;
			const directory = config.stateRoot;
			const paths = [directory];
			for (const name of await readdir(directory)) {
				if (!name.startsWith("qmd-public-")) continue;
				const indexed = join(directory, name);
				await protectedDir(indexed);
				leases.push(await acquireIndexOwnership(indexed));
				paths.push(indexed);
			}
			for (const parent of paths) {
				const path = join(parent, "jobs.json");
				const info = await exists(path);
				if (!info) continue;
				if (info.nlink !== 1 || (parent !== directory && parent !== qmdApplicationDirectory(config, "2.8.3"))) throw fail("Unverifiable legacy ledger provenance");
				const bytes = await readOwnedBytes(path, false);
				const raw = parseSharedJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				const probePath = join(scratch, "jobs.json");
				await writeFile(probePath, bytes, { flag: "wx", mode: 0o600 });
				const probe = new MaintenanceCoordinator(probePath, () => new Set([member.id]));
				try {
					await probe.ensureLoaded();
					const jobs = probe.jobs();
					if (!Array.isArray(raw.jobs) || raw.jobs.length !== jobs.length || jobs.some(job => job.stores.length !== 1 || job.state === "queued" || job.state === "running" || job.definition !== sourceDefinition([store], job.mode === "metadata" ? undefined : { version: "2.8.3" }))) throw fail("Legacy ledger has unfinished or unverifiable receipts");
					histories.push({ path, archive: `ledger-${histories.length}.json`, sha256: createHash("sha256").update(bytes).digest("hex"), jobs: jobs.length });
					await writeFile(join(scratch, histories.at(-1)!.archive), bytes, { flag: "wx", mode: 0o600 });
				} finally { probe.shutdown(); await probe.settled(); await rm(probePath, { force: true }); }
			}
		}
		if (!(await readOwnedBytes(catalogPath)).equals(original) || await exists(newStateRoot)) throw fail("Inputs changed during preparation");
		const write = (name: string, value: unknown) => writeFile(join(scratch!, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		const declarations = Object.fromEntries(members.map(member => [member.id, parseDeclaration({ root: member.root, include: member.include, exclude: member.exclude })]));
		await writeFile(join(scratch, "catalog.json"), original, { flag: "wx", mode: 0o600 });
		await write("host.json", { schemaVersion: 1, stateRoot: newStateRoot, socketPath: catalog.socketPath, defaults: catalog.defaults, qmd: catalog.qmd, reader });
		await write("registrations.json", { schemaVersion: 1, registrations: Object.fromEntries(Object.values(declarations).map(({ root, include, exclude }) => [root, { include, exclude }])) });
		await write("report.json", { schemaVersion: 1, generation: "new-ledgers-no-adoption", catalogPath, oldStateRoot: catalog.stateRoot, bindings: members, declarations, histories });
		await mkdir(output, { mode: 0o700 });
		created = true;
		// Publish the report last; an incomplete bundle is not a cutover plan.
		for (const name of (await readdir(scratch)).filter(name => name !== "report.json").concat("report.json")) {
			await writeFile(join(output, name), await readFile(join(scratch, name)), { flag: "wx", mode: 0o600 });
		}
	} catch (error) {
		if (created) await rm(output, { recursive: true, force: true });
		throw error;
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
		for (const lease of leases.reverse()) await lease.release();
	}
}
