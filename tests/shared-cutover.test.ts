import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
import { prepareSharedCutover } from "../src/shared-cutover.ts";
import { startSharedHost, type SharedHost } from "../src/shared-host.ts";
import { declarationId } from "../src/shared-registrations.ts";

test("three client rollout refuses unsafe history and prepares a separate generation without editing originals", async t => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "ds-")));
	const home = process.env.HOME;
	process.env.HOME = base;
	let host: SharedHost | undefined;
	const clients: SharedIndexClient[] = [];
	t.after(async () => {
		try { await Promise.all(clients.map(client => client.shutdown())); await host?.close(); await rm(base, { recursive: true, force: true }); }
		finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
	});
	const root = join(base, "notes"), stateRoot = join(base, "old-state"), newState = join(base, "new-state");
	const catalog = join(base, "catalog.json"), socketPath = join(base, "socket"), bundle = join(base, "bundle");
	const note = "---\ntags: [copper]\n---\n# Copper\n";
	await mkdir(root);
	await writeFile(join(root, "one.md"), note);
	const defaults = { operationTimeoutMs: 10000 };
	const qmd = { enabled: false, installation: { executable: "unused" }, minimumVersion: "2.8.3" };
	const definition = { root, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notebook" } };
	const catalogBytes = JSON.stringify({ schemaVersion: 1, stateRoot, socketPath, defaults, qmd, stores: { notebook: definition } });
	await writeFile(catalog, catalogBytes, { mode: 0o600 });
	const oldConfig = { schemaVersion: 1, defaults, qmd, stores: { book: { shared: { catalog, store: "notebook" } } } };
	const project = async (index: number, config: unknown) => {
		const cwd = join(base, `project-${index}`), dir = join(cwd, ".pi", "markdown-datastore");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
		const resolved = await loadMarkdownDatastoreConfig(cwd);
		const client = new SharedIndexClient(resolved.stores.get("book")!.shared!);
		clients.push(client);
		return { client, service: new MarkdownDatastoreService(resolved) };
	};
	const stop = async () => { await host!.close(); host = undefined; };
	host = await startSharedHost(catalog);
	const generation = host.generation;
	const old = [];
	for (let i = 0; i < 3; i++) {
		const staged = await project(i, oldConfig);
		await staged.client.status();
		assert.equal(host.generation, generation);
		assert.equal(host.coordinators.size, 1);
		old.push(staged);
	}
	const receipt = await old[0].client.startMetadata();
	const id = String(receipt.refreshId);
	await host.coordinators.get("notebook")!.settled();
	assert.equal(host.coordinators.get("notebook")!.get(id)?.state, "succeeded");
	await assert.rejects(prepareSharedCutover(catalog, bundle, newState), { code: "STORE_UNAVAILABLE" });
	await stop();
	const oldJobs = join(stateRoot, "notebook", "jobs.json");
	const bytes = await readFile(oldJobs, "utf8");
	await assert.rejects(old[0].client.status(), { code: "STORE_UNAVAILABLE" });
	assert.match((await old[0].service.read({ note: { store: "book", path: "one.md" }, view: "content" })).data.content!, /Copper/);
	for (const change of [{ state: "queued", phase: "queued" }, { definition: "0".repeat(64) }]) {
		const raw = JSON.parse(bytes);
		Object.assign(raw.jobs[0], change);
		const rejected = JSON.stringify(raw);
		await writeFile(oldJobs, rejected);
		await assert.rejects(prepareSharedCutover(catalog, bundle, newState), { code: "STORE_UNAVAILABLE" });
		assert.equal(await readFile(oldJobs, "utf8"), rejected);
		await assert.rejects(stat(bundle), { code: "ENOENT" });
	}
	await writeFile(oldJobs, bytes);
	host = await startSharedHost(catalog);
	assert.equal(host.coordinators.get("notebook")!.get(id)?.state, "succeeded");
	await stop();
	const stoppedBytes = await readFile(oldJobs, "utf8");
	await prepareSharedCutover(catalog, bundle, newState);
	assert.equal(await readFile(join(bundle, "ledger-0.json"), "utf8"), stoppedBytes);
	assert.equal(await readFile(oldJobs, "utf8"), stoppedBytes);
	assert.equal(await readFile(join(bundle, "catalog.json"), "utf8"), catalogBytes);
	await assert.rejects(stat(newState), { code: "ENOENT" });
	const report = JSON.parse(await readFile(join(bundle, "report.json"), "utf8"));
	assert.equal(report.generation, "new-ledgers-no-adoption");
	const configDir = join(base, ".pi", "markdown-datastore");
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	for (const file of ["host.json", "registrations.json"]) await writeFile(join(configDir, file), await readFile(join(bundle, file)), { mode: 0o600 });
	const newConfig = { schemaVersion: 1, stores: { book: { shared: report.declarations.notebook } } };
	host = await startSharedHost(join(configDir, "host.json"), { declarations: true });
	const current = host.coordinators.get(declarationId(root))!;
	assert.deepEqual(current.jobs(), []);
	await assert.rejects(startSharedHost(catalog), { code: "STORE_UNAVAILABLE" });
	const migrated = [];
	for (let i = 0; i < 3; i++) {
		const staged = await project(i, newConfig);
		await staged.client.status();
		migrated.push(staged);
	}
	const fresh = await migrated[0].client.startMetadata();
	await current.settled();
	assert.equal(current.get(String(fresh.refreshId))?.state, "succeeded", JSON.stringify(current.get(String(fresh.refreshId))));
	assert.equal(current.get(id), undefined);
	for (const { client } of migrated) assert.deepEqual((await client.tags()).tags.map(tag => tag.identity), ["copper"]);
	assert.equal(await readFile(oldJobs, "utf8"), stoppedBytes);
	assert.equal(await readFile(join(root, "one.md"), "utf8"), note);
});
