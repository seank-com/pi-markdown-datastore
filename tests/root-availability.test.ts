import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configuredStoreNames, loadMarkdownDatastoreConfig, resolveConfiguredStore } from "../src/config.ts";
import { createMarkdownDatastoreExtension } from "../src/index.ts";
import { createMarkdownDatastoreClient, queryMarkdownDatastoreCapability } from "../src/client.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
import { loadSharedCatalog } from "../src/shared-catalog.ts";
import { startSharedHost } from "../src/shared-host.ts";
import { isRootUnavailable, observeSource, rejectSharedStore } from "../src/root-binding.ts";
import { createQmdFixture } from "./fixtures/qmd-fixture.ts";
import { discoverQmdBinding, qmdApplicationDirectory, QmdAdapter } from "../src/qmd-adapter.ts";
import { MaintenanceCoordinator, sourceDefinition } from "../src/maintenance-coordinator.ts";
import { MetadataIndex, reconcileChanged, registerMetadata } from "../src/metadata-index.ts";

const code = (expected: string) => (error: any) => error.code === expected;
async function fixture(t: test.TestContext) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "ds-roots-")));
	const project = join(base, "project"), directory = join(project, ".pi/markdown-datastore");
	await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
	const live = join(base, "live"), remote = join(base, "remote");
	await mkdir(live); await mkdir(remote);
	await writeFile(join(live, "one.md"), "# Live\nHealthy source\n");
	await writeFile(join(remote, "one.md"), "# Remote\nReturned source\n");
	const definition = (root: string, name: string) => ({ root, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: name } });
	const defaults = { operationTimeoutMs: 1000 };
	const qmd = { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" };
	const raw: any = { schemaVersion: 1, defaults, qmd: { ...qmd }, stores: { live: definition(live, "live"), remote: definition(remote, "remote") } };
	const configPath = join(directory, "config.json");
	const save = () => writeFile(configPath, JSON.stringify(raw), { mode: 0o600 }); await save();
	const catalog = join(base, "catalog.json"), socketPath = join(base, "md.sock");
	const catalogRaw: any = { schemaVersion: 1, defaults, qmd, stateRoot: join(base, "state"), socketPath, stores: { live: definition(live, "live"), remote: definition(remote, "remote") } };
	const saveCatalog = () => writeFile(catalog, JSON.stringify(catalogRaw), { mode: 0o600 }); await saveCatalog();
	const cleanup: Array<() => Promise<unknown>> = [];
	t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(base, { recursive: true, force: true }); });
	const load = () => loadMarkdownDatastoreConfig(project);
	return { base, project, live, remote, raw, save, configPath, load, catalog, catalogRaw, saveCatalog, definition, cleanup };
}
async function extension(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>, createQmd?: any) {
	const emitter = new EventEmitter(), handlers = new Map<string, Function>();
	const events = { emit: (name: string, value: unknown) => emitter.emit(name, value), on(name: string, listener: (value: unknown) => void) { emitter.on(name, listener); return () => { emitter.off(name, listener); }; } };
	createMarkdownDatastoreExtension({ projectRoot: f.project, createQmd })({ events, registerTool() {}, appendEntry() {}, on(name: string, handler: Function) { handlers.set(name, handler); } } as any);
	const ctx = { isProjectTrusted: () => true, ui: { setStatus() {} } };
	await handlers.get("session_start")!({}, ctx);
	f.cleanup.push(() => handlers.get("session_shutdown")!({}, ctx));
	return { client: createMarkdownDatastoreClient(events, { capability: queryMarkdownDatastoreCapability(events) }), capability: queryMarkdownDatastoreCapability(events)! };
}

test("unavailable catalog sibling does not invalidate a healthy reference or private store", async t => {
	const f = await fixture(t); await rm(f.remote, { recursive: true });
	f.raw.stores = { private: f.definition(f.live, "private"), shared: { shared: { catalog: f.catalog, store: "live" } } }; await f.save();
	const catalog = await loadSharedCatalog(f.catalog);
	assert.deepEqual([...catalog.stores.keys()], ["live"]); assert.deepEqual([...catalog.unavailableStores.keys()], ["remote"]);
	const config = await f.load(); assert.deepEqual(configuredStoreNames(config), ["private", "shared"]);
	const service = new MarkdownDatastoreService(config); f.cleanup.push(() => service.shutdown());
	assert.match(String((await service.read({ note: { store: "private", path: "one.md" } })).data.content), /Healthy source/);
	assert.match(String((await service.read({ note: { store: "shared", path: "one.md" } })).data.content), /Healthy source/);
});

test("same-session operations bind a returned private root without re-reading configuration", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	const { client, capability } = await extension(t, f);
	assert.equal(capability.ready, true); assert.deepEqual(new Set(capability.stores), new Set(["live", "remote"]));
	await assert.rejects(client.read({ note: { store: "remote", path: "one.md" } }), code("STORE_UNAVAILABLE"));
	assert.match(String((await client.read({ note: { store: "live", path: "one.md" } })).data.content), /Healthy source/);
	const status = await client.status({});
	assert.equal((status.data.stores as any[]).find(store => store.store === "remote").capabilities.direct.state, "unavailable");
	await assert.rejects(client.roots({}), code("STORE_UNAVAILABLE"));
	await assert.rejects(client.validateDestination({ path: join(f.base, "outside.md") }), code("STORE_UNAVAILABLE"));
	const refresh = await client.refresh({ mode: "direct" });
	assert.deepEqual(refresh.data.roots, { live: "available" }); assert.equal(refresh.warnings[0]?.code, "STORE_UNAVAILABLE");
	await writeFile(f.configPath, "{not current configuration}");
	await rename(`${f.remote}-away`, f.remote);
	const results = await Promise.all(Array.from({ length: 4 }, () => client.read({ note: { store: "remote", path: "one.md" } })));
	assert.ok(results.every(result => String(result.data.content).includes("Returned source")));
	assert.equal((await client.roots({})).data.roots.length, 2);
});

test("bound store serialization preserves the historical private directory fingerprint", async t => {
	const f = await fixture(t), config = await f.load();
	const historical = new Map([...config.stores].map(([name, store]) => [name, {
		name: store.name, configuredRoot: store.configuredRoot, root: store.root, rootWasSymlink: store.rootWasSymlink, rootDev: store.rootDev, rootIno: store.rootIno,
		include: store.include, exclude: store.exclude, maxFileBytes: store.maxFileBytes, search: store.search,
	}]));
	assert.equal(qmdApplicationDirectory(config, "2.8.3"), qmdApplicationDirectory({ ...config, stores: historical }, "2.8.3"));
});

test("late duplicate private roots stay unbound without disabling the first captured store", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	f.raw.stores.other = f.definition(f.remote, "other"); await f.save();
	const config = await f.load(); await rename(`${f.remote}-away`, f.remote);
	await resolveConfiguredStore(config, "remote");
	await assert.rejects(resolveConfiguredStore(config, "other"), code("STORE_UNAVAILABLE"));
	assert.equal(config.stores.has("other"), false);
	const service = new MarkdownDatastoreService(config); f.cleanup.push(() => service.shutdown());
	assert.match(String((await service.read({ note: { store: "remote", path: "one.md" } })).data.content), /Returned source/);
});

test("concurrent different-name late bindings atomically exclude duplicate private roots", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	f.raw.stores.other = f.definition(f.remote, "other"); await f.save(); const config = await f.load();
	await rename(`${f.remote}-away`, f.remote);
	const results = await Promise.allSettled([resolveConfiguredStore(config, "remote"), resolveConfiguredStore(config, "other")]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "STORE_UNAVAILABLE").length, 1);
});

test("a malformed catalog on its first readable operation fails closed rather than becoming partial authority", async t => {
	const f = await fixture(t); await rm(f.catalog);
	f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } }; await f.save();
	const { client } = await extension(t, f);
	await writeFile(f.catalog, "{}", { mode: 0o600 });
	await assert.rejects(client.read({ note: { store: "remote", path: "one.md" } }), code("CONFIG_VERSION_UNSUPPORTED"));
	await assert.rejects(client.read({ note: { store: "live", path: "one.md" } }), code("CONFIG_VERSION_UNSUPPORTED"));
	await assert.rejects(client.status({}), code("CONFIG_VERSION_UNSUPPORTED"));
});

test("a bound root returns with the same inode but a replacement is never adopted", async t => {
	const f = await fixture(t), config = await f.load();
	const service = new MarkdownDatastoreService(config); f.cleanup.push(() => service.shutdown());
	const original = config.stores.get("remote")!;
	await rename(f.remote, `${f.remote}-away`);
	await assert.rejects(service.find({ store: "remote", selectors: [{ kind: "path", path: "one.md" }] }), code("STORE_UNAVAILABLE"));
	await rename(`${f.remote}-away`, f.remote);
	assert.equal((await service.find({ store: "remote", selectors: [{ kind: "path", path: "one.md" }] })).data.candidates.length, 1);
	await rename(f.remote, `${f.remote}-away`); await mkdir(f.remote); await writeFile(join(f.remote, "one.md"), "Replacement\n");
	await assert.rejects(service.read({ note: { store: "remote", path: "one.md" } }), code("STORE_UNAVAILABLE"));
	assert.equal(config.stores.get("remote")!.rootIno, original.rootIno);
	assert.match(String((await service.read({ note: { store: "live", path: "one.md" } })).data.content), /Healthy source/);
});

test("missing catalog authority defers only its references and binds once the catalog can first be read", async t => {
	const f = await fixture(t); await rename(f.catalog, `${f.catalog}-away`);
	f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } }; await f.save();
	const { client } = await extension(t, f);
	assert.match(String((await client.read({ note: { store: "live", path: "one.md" } })).data.content), /Healthy source/);
	await assert.rejects(client.read({ note: { store: "remote", path: "one.md" } }), code("STORE_UNAVAILABLE"));
	await rename(`${f.catalog}-away`, f.catalog);
	assert.match(String((await client.read({ note: { store: "remote", path: "one.md" } })).data.content), /Returned source/);
});

test("shared host admits healthy members, then single-flights a returned member without a restart", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	const host = await startSharedHost(f.catalog); f.cleanup.push(() => host.close());
	assert.equal(host.coordinators.size, 1);
	f.raw.stores = { live: { shared: { catalog: f.catalog, store: "live" } }, remote: { shared: { catalog: f.catalog, store: "remote" } } }; await f.save();
	const { client } = await extension(t, f);
	const healthy = await client.refresh({ store: "live", mode: "metadata" }); assert.ok(healthy.data.qmd);
	await assert.rejects(client.refresh({ store: "remote", mode: "metadata" }), code("STORE_UNAVAILABLE"));
	await rename(`${f.remote}-away`, f.remote);
	const statuses = await Promise.all(Array.from({ length: 4 }, () => client.status({ store: "remote" })));
	assert.ok(statuses.every(result => (result.data.stores as any[])[0].capabilities.direct.state === "ready"));
	assert.equal(host.coordinators.size, 2);
	assert.ok((await client.refresh({ store: "remote", mode: "metadata" })).data.qmd);
	const captured = host.catalog.stores.get("remote")!;
	await rename(f.remote, `${f.remote}-away`); await mkdir(f.remote);
	await assert.rejects(client.refresh({ store: "remote", mode: "metadata" }), code("STORE_UNAVAILABLE"));
	assert.equal(host.catalog.stores.get("remote")!.rootIno, captured.rootIno);
});

test("a rejected first hello can discard only provisional capture and heals when the host's original root returns", async t => {
	const f = await fixture(t), host = await startSharedHost(f.catalog); f.cleanup.push(() => host.close());
	await rename(f.remote, `${f.remote}-away`);
	f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } };
	f.raw.stores.blocked = f.definition(join(f.base, "missing"), "blocked"); await f.save();
	const { client } = await extension(t, f);
	await mkdir(f.remote); await writeFile(join(f.remote, "one.md"), "Replacement\n");
	// A failed complete-scope policy must not commit the provisional root it inspected.
	await assert.rejects(client.roots({}), code("STORE_UNAVAILABLE"));
	await assert.rejects(client.refresh({ store: "remote", mode: "metadata" }), code("STORE_UNAVAILABLE"));
	await rm(f.remote, { recursive: true }); await rename(`${f.remote}-away`, f.remote);
	assert.ok((await client.refresh({ store: "remote", mode: "metadata" })).data.qmd);
});

test("failed policy and direct refresh leave no sticky shared identity when no host can reject it", async t => {
	for (const operation of ["policy", "refresh"] as const) {
		const f = await fixture(t);
		f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } };
		f.raw.stores.blocked = f.definition(join(f.base, "missing"), "blocked"); await f.save();
		const { client } = await extension(t, f);
		if (operation === "policy") await assert.rejects(client.roots({}), code("STORE_UNAVAILABLE"));
		else await assert.rejects(client.refresh({ store: "remote", mode: "direct", maxBytes: 1 }), code("RESULT_LIMIT_EXCEEDED"));
		await rename(f.remote, `${f.remote}-away`); await mkdir(f.remote); await writeFile(join(f.remote, "one.md"), "New first successful observation\n");
		assert.match(String((await client.read({ note: { store: "remote", path: "one.md" } })).data.content), /New first successful observation/);
	}
});

test("a failed observation cannot discard the exact root another in-flight observation successfully returns", async t => {
	const f = await fixture(t); f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } }; await f.save();
	const config = await f.load(), store = config.stores.get("remote")!;
	const failed = observeSource(store), successful = observeSource(store);
	failed(false); assert.equal(config.stores.get("remote"), store);
	successful(true); assert.equal(config.stores.get("remote"), store);
	const laterFailure = observeSource(store); laterFailure(false); assert.equal(config.stores.get("remote"), store);
});

test("successful direct shared reads commit their own source identity without needing a live host", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } }; await f.save();
	const { client } = await extension(t, f);
	await mkdir(f.remote); await writeFile(join(f.remote, "one.md"), "Replacement served directly\n");
	assert.match(String((await client.read({ note: { store: "remote", path: "one.md" } })).data.content), /Replacement served directly/);
	await assert.rejects(client.refresh({ store: "remote", mode: "metadata" }), code("STORE_UNAVAILABLE"));
	await rm(f.remote, { recursive: true }); await rename(`${f.remote}-away`, f.remote);
	await assert.rejects(client.read({ note: { store: "remote", path: "one.md" } }), code("STORE_UNAVAILABLE"));
});

test("a successful complete policy commits shared roots even when the shared service is down", async t => {
	const f = await fixture(t); f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } }; await f.save();
	const { client } = await extension(t, f); assert.equal((await client.roots({})).data.roots.length, 2);
	await assert.rejects(client.refresh({ store: "remote", mode: "metadata" }), code("STORE_UNAVAILABLE"));
	await rename(f.remote, `${f.remote}-away`); await mkdir(f.remote); await writeFile(join(f.remote, "one.md"), "Replacement\n");
	await assert.rejects(client.read({ note: { store: "remote", path: "one.md" } }), code("STORE_UNAVAILABLE"));
});

test("an in-flight source observation wins over provisional discard only if that exact observation succeeds", async t => {
	const f = await fixture(t); f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } }; await f.save();
	const config = await f.load(), store = config.stores.get("remote")!;
	const finish = observeSource(store); rejectSharedStore(store);
	assert.equal(config.stores.get("remote"), store); finish(true);
	assert.equal(config.stores.get("remote"), store); rejectSharedStore(store);
	assert.equal(config.stores.get("remote"), store);
	const second = await f.load(), abandoned = second.stores.get("remote")!, fail = observeSource(abandoned);
	rejectSharedStore(abandoned); assert.equal(second.stores.get("remote"), abandoned); fail(false);
	assert.equal(second.stores.has("remote"), false);
	assert.throws(() => observeSource(abandoned), code("STORE_UNAVAILABLE"));
	assert.notEqual(await resolveConfiguredStore(second, "remote"), abandoned);
});

test("failed lazy shared admission releases ownership and never publishes a half-loaded coordinator", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	const host = await startSharedHost(f.catalog); f.cleanup.push(() => host.close());
	const state = join(f.base, "state/remote"); await mkdir(state, { mode: 0o700 });
	await writeFile(join(state, "jobs.json"), "bad ledger", { mode: 0o600 });
	f.raw.stores.remote = { shared: { catalog: f.catalog, store: "remote" } }; await f.save();
	const { client } = await extension(t, f); await rename(`${f.remote}-away`, f.remote);
	await assert.rejects(client.refresh({ store: "remote", mode: "metadata" }), code("INDEX_CORRUPT"));
	assert.equal(host.coordinators.has("remote"), false);
	assert.match(String((await client.read({ note: { store: "live", path: "one.md" } })).data.content), /Healthy source/);
	await writeFile(join(state, "jobs.json"), JSON.stringify({ version: 1, jobs: [] }), { mode: 0o600 });
	assert.ok((await client.refresh({ store: "remote", mode: "metadata" })).data.qmd);
	assert.equal(host.coordinators.has("remote"), true);
});

test("an unsafe returning root stays unbound and can later bind only after full validation", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	const { client } = await extension(t, f);
	await symlink(`${f.remote}-away`, f.remote);
	await assert.rejects(client.read({ note: { store: "remote", path: "one.md" } }), code("STORE_UNAVAILABLE"));
	assert.match(String((await client.read({ note: { store: "live", path: "one.md" } })).data.content), /Healthy source/);
	await rm(f.remote); await rename(`${f.remote}-away`, f.remote);
	assert.match(String((await client.read({ note: { store: "remote", path: "one.md" } })).data.content), /Returned source/);
});

test("structural errors still fail load even beside unavailable members", async t => {
	const f = await fixture(t); await rm(f.remote, { recursive: true });
	f.raw.stores.remote.maxFileBytes = -1; await f.save(); await assert.rejects(f.load(), code("CONFIG_INVALID"));
	f.raw.stores.remote = f.definition(f.remote, "remote");
	await symlink(f.remote, join(f.base, "dangling")); f.raw.stores.remote.root = join(f.base, "dangling"); await f.save();
	await assert.rejects(f.load(), code("SYMLINK_REJECTED"));
	f.catalogRaw.stores.remote.root = join(f.base, "dangling"); await f.saveCatalog();
	f.raw.stores.remote = { shared: { catalog: f.catalog, store: "live" } }; await f.save();
	await assert.rejects(f.load(), code("CONFIG_INVALID"));
	f.raw.stores.remote = f.definition(f.live, "remote"); await f.save(); await assert.rejects(f.load(), code("CONFIG_INVALID"));
});

test("each private backend receives one bound store and cannot poison a healthy peer", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`); f.raw.qmd.enabled = true; await f.save();
	const created: string[] = [];
	const { client } = await extension(t, f, async (config: any) => {
		assert.equal(config.stores.size, 1);
		const store = [...config.stores.values()][0] as any; assert.equal(store.rootIno, (await lstat(store.root)).ino); created.push(store.name);
		return { binding: { version: "fixture" }, startupReconcile: async () => ({}), shutdown: async () => undefined,
			activity: () => ({ jobs: [], embeddingActive: false }), isLexicallyCurrent: () => true,
			search: async () => ({ candidates: [], rejectedCandidates: 0, manifest: { stores: { [store.name]: {} }, pendingEmbeddings: 0 }, generation: `gen-${"a".repeat(32)}`, requestedMode: "lexical", effectiveMode: "lexical" }) };
	});
	assert.deepEqual(created, ["live"]);
	assert.equal((await client.search({ store: "live", query: "healthy" })).data.returned, 0);
	await rename(`${f.remote}-away`, f.remote); await client.search({ store: "remote", query: "returned" });
	assert.deepEqual(created, ["live", "remote"]);
	await rename(f.remote, `${f.remote}-away`);
	assert.equal((await client.search({ store: "live", query: "healthy" })).data.returned, 0);
});

test("unavailable roots do not stop later metadata inventory and scoped runners keep one ledger", async t => {
	const f = await fixture(t), config = await f.load();
	const coordinator = new MaintenanceCoordinator(join(f.base, "jobs.json"), () => new Set(config.stores.keys()));
	f.cleanup.push(async () => { coordinator.shutdown(); await coordinator.settled(); });
	const indexes = new Map([...config.stores].reverse().map(([name]) => [name, new MetadataIndex(join(f.base, `metadata-${name}`))]));
	registerMetadata(coordinator, indexes, config.stores);
	await rename(f.remote, `${f.remote}-away`);
	await reconcileChanged(coordinator, indexes, new Map([...config.stores].reverse()));
	assert.ok(await indexes.get("live")!.snapshot()); assert.equal(await indexes.get("remote")!.snapshot(), undefined);
	const ran: string[] = [];
	coordinator.register("lexical", async job => { ran.push(job.stores.join(",")); return { generation: `gen-${"a".repeat(32)}` }; }, ["live"]);
	coordinator.register("lexical", async job => { ran.push(job.stores.join(",")); return { generation: `gen-${"b".repeat(32)}` }; }, ["remote"]);
	const receipt = await coordinator.enqueue("lexical", ["live", "remote"], "explicit-maintenance");
	await coordinator.persisted(String(receipt.refreshId)); assert.deepEqual(ran.sort(), ["live", "remote"]);
	assert.equal(coordinator.get(String(receipt.refreshId))!.state, "succeeded");
	assert.equal(coordinator.get(String(receipt.refreshId))!.generation, undefined);
});

test("unbound definitions cannot replay old work and recovery preserves its receipt", async t => {
	const f = await fixture(t), original = (await f.load()).stores.get("remote")!;
	const jobs = join(f.base, "jobs.json");
	const first = new MaintenanceCoordinator(jobs, () => new Set(["remote"]));
	const receipt = await first.enqueue("metadata", ["remote"], "explicit-maintenance", sourceDefinition([original])); first.shutdown(); await first.settled();
	await rename(f.remote, `${f.remote}-away`); const config = await f.load();
	let ran = 0;
	const next = new MaintenanceCoordinator(jobs, () => new Set(["remote"]), () => { const store = config.stores.get("remote"); return store ? sourceDefinition([store]) : undefined; });
	f.cleanup.push(async () => { next.shutdown(); await next.settled(); });
	next.register("metadata", async () => { ran++; }); await next.ensureLoaded(); next.relaunchQueued(); await next.settled();
	assert.equal(ran, 0); assert.equal(next.get(String(receipt.refreshId))!.state, "queued");
	await assert.rejects(next.enqueue("metadata", ["remote"], "explicit-maintenance"), code("STORE_UNAVAILABLE"));
	await rename(`${f.remote}-away`, f.remote); await resolveConfiguredStore(config, "remote"); next.relaunchQueued(); await next.persisted(String(receipt.refreshId));
	assert.equal(ran, 1); assert.equal(next.get(String(receipt.refreshId))!.definition, receipt.definition);
});

test("real adapter paths keep healthy indexed operations and receipts isolated during a sibling outage", async t => {
	const f = await fixture(t); await rename(f.remote, `${f.remote}-away`);
	f.raw.qmd.enabled = true; f.raw.qmd.installation = { packageRoot: await createQmdFixture(f.base) }; await f.save();
	const adapters = new Map<string, QmdAdapter>();
	const { client } = await extension(t, f, async (config: any, coordinator: MaintenanceCoordinator) => {
		const adapter = new QmdAdapter(config, await discoverQmdBinding(config), coordinator);
		adapters.set([...config.stores.keys()][0] as string, adapter); return adapter;
	});
	const first = await client.refresh({ mode: "lexical" });
	await adapters.get("live")!.coordinator.persisted(String((first.data.qmd as any).refreshId));
	assert.equal(first.warnings[0]?.code, "STORE_UNAVAILABLE");
	assert.equal((await client.search({ store: "live", query: "Healthy" })).data.returned, 1);
	await rename(`${f.remote}-away`, f.remote);
	const returned = await client.refresh({ store: "remote", mode: "lexical" });
	await adapters.get("remote")!.coordinator.persisted(String((returned.data.qmd as any).refreshId));
	assert.equal((await client.search({ store: "remote", query: "Returned" })).data.returned, 1);
	assert.equal(adapters.get("remote")!.coordinator, adapters.get("live")!.coordinator);
	await rename(f.remote, `${f.remote}-away`);
	assert.equal((await client.search({ store: "live", query: "Healthy" })).data.returned, 1);
	const healthy = (await client.status({ store: "live" })).data.stores as any[];
	assert.equal(healthy[0].capabilities.search.lexical.state, "ready");
	const again = await client.refresh({ store: "live", mode: "lexical" });
	await adapters.get("live")!.coordinator.persisted(String((again.data.qmd as any).refreshId));
	assert.equal(adapters.get("live")!.coordinator.get(String((again.data.qmd as any).refreshId))!.state, "succeeded");
});

test("shutdown settles lazy admission before closing backends created by that admission", async t => {
	const f = await fixture(t), config = await f.load();
	let entered!: () => void, release!: () => void, closed = false;
	const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
	const backends = new Map<string, QmdAdapter>();
	const service = new MarkdownDatastoreService(config, undefined, undefined, undefined, backends, async store => {
		entered(); await gate; backends.set(store.name, { shutdown: async () => { closed = true; } } as any);
	});
	f.cleanup.push(() => service.shutdown());
	const operation = service.read({ note: { store: "live", path: "one.md" } });
	const rejected = assert.rejects(operation, code("CANCELLED"));
	await started; const shutdown = service.shutdown(); release(); await rejected; await shutdown;
	assert.equal(closed, true);
});

test("incomplete historical provenance defers maintenance without disabling healthy direct reads", async t => {
	const f = await fixture(t), original = await f.load();
	const historyPath = join(qmdApplicationDirectory(original, "2.8.3"), "jobs.json");
	const legacy = new MaintenanceCoordinator(historyPath, () => new Set(original.stores.keys()));
	const receipt = await legacy.enqueue("metadata", ["live"], "explicit-maintenance", sourceDefinition([original.stores.get("live")!]));
	legacy.shutdown(); await legacy.settled(); const bytes = await readFile(historyPath);
	await rename(f.remote, `${f.remote}-away`);
	const { client, capability } = await extension(t, f);
	assert.equal(capability.ready, true);
	assert.match(String((await client.read({ note: { store: "live", path: "one.md" } })).data.content), /Healthy source/);
	assert.equal(((await client.status({ store: "live" })).data.stores as any[])[0].capabilities.direct.state, "ready");
	await assert.rejects(lstat(join(original.stateRoot, "jobs.json")), { code: "ENOENT" });
	await assert.rejects(client.refresh({ store: "live", mode: "metadata" }), code("STORE_UNAVAILABLE"));
	assert.deepEqual(await readFile(historyPath), bytes);
	await rename(`${f.remote}-away`, f.remote);
	await client.read({ note: { store: "remote", path: "one.md" } });
	const adopted = JSON.parse(await readFile(join(original.stateRoot, "jobs.json"), "utf8"));
	assert.ok(adopted.jobs.some((job: any) => job.refreshId === receipt.refreshId && job.definition === receipt.definition));
	assert.deepEqual(await readFile(historyPath), bytes);
});

test("root liveness classification contains network IO failures but not authority failures", () => {
	for (const value of ["ENOENT", "EIO", "ETIMEDOUT", "ESTALE", "ENODEV", "ENXIO", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH"]) assert.equal(isRootUnavailable({ code: value }), true);
	for (const value of ["EACCES", "EPERM", "ELOOP", "ENOTDIR"]) assert.equal(isRootUnavailable({ code: value }), false);
});
