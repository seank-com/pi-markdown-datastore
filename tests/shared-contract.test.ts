import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { watch } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { discoverQmdBinding, QmdAdapter, type QmdRefreshJob } from "../src/qmd-adapter.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
import { startSharedHost, type SharedHost } from "../src/shared-host.ts";
import { attachSharedParser, encodeSharedMessage, requestId } from "../src/shared-ipc.ts";
import { createQmdFixture } from "./fixtures/qmd-fixture.ts";

async function present(path: string): Promise<boolean> {
	try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function fixture(t: import("node:test").TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "shared-contract-")));
	const sockets = `/tmp/d4contract-${process.pid}`;
	await mkdir(sockets, { mode: 0o700 }); await chmod(sockets, 0o700);
	const observers = new Set<() => void>(), services: MarkdownDatastoreService[] = [];
	const children = new Map<ChildProcess, Promise<void>>();
	const trackChild = (child: ChildProcess) => { const done = new Promise<void>(resolve => child.once("exit", () => resolve())); children.set(child, done); return done; };
	const stopChild = async (child: ChildProcess) => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await children.get(child); };
	let host: SharedHost | undefined;
	t.after(async () => {
		for (const close of observers) close();
		await Promise.all(services.map(service => service.shutdown()));
		await host?.close();
		await Promise.all([...children.keys()].map(stopChild));
		await rm(sockets, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
	});
	const observe = <T>(directory: string, read: () => Promise<T | undefined>): Promise<T> => new Promise((resolve, reject) => {
		let busy = false, again = false, settled = false;
		const finish = (error?: unknown, value?: T) => { if (settled) return; settled = true; watcher.close(); observers.delete(cancel); error ? reject(error) : resolve(value!); };
		const check = async () => {
			if (settled) return;
			if (busy) { again = true; return; }
			busy = true;
			try { const result = await read(); if (result !== undefined) finish(undefined, result); }
			catch (error) { finish(error); }
			finally { busy = false; if (again) { again = false; void check(); } }
		};
		const watcher = watch(directory, () => { void check(); });
		const cancel = () => finish(new Error("Fixture observer cancelled at teardown"));
		observers.add(cancel); watcher.on("error", finish); void check();
	});
	const job = (adapter: QmdAdapter, id: string) => observe(adapter.root, async () => {
		if (!await present(join(adapter.root, "jobs.json"))) return undefined;
		const persisted = JSON.parse(await readFile(join(adapter.root, "jobs.json"), "utf8")) as { jobs: QmdRefreshJob[] };
		const value = persisted.jobs.find(item => item.refreshId === id);
		return value && ["succeeded", "failed", "cancelled"].includes(value.state) ? value : undefined;
	});
	const entered = (adapter: QmdAdapter, name: string, id?: string) => observe(adapter.root, async () => {
		if (await present(join(adapter.root, name + ".entered"))) return true;
		const state = id && adapter.activity().jobs.find(item => item.refreshId === id);
		if (state && ["succeeded", "failed", "cancelled"].includes(state.state)) throw new Error("Operation ended before entering its held fixture gate");
		return undefined;
	});
	const behavior = (adapter: QmdAdapter, value: unknown) => writeFile(join(adapter.root, "behavior.json"), JSON.stringify(value), { mode: 0o600 });
	const release = (adapter: QmdAdapter, name: string) => writeFile(join(adapter.root, name + ".release"), "", { mode: 0o600 });
	const packageRoot = await createQmdFixture(root);
	const stores: Record<string, unknown> = {};
	for (const name of ["notebook", "archive"]) {
		const path = join(root, name); await mkdir(path, { mode: 0o700 });
		await writeFile(join(path, "copper.md"), `# ${name}\nCopper ${name} note.\n`);
		stores[name] = { root: path, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } };
	}
	const qmd = { enabled: true, installation: { packageRoot }, minimumVersion: "2.8.3" };
	const defaults = { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 };
	const catalog = join(root, "catalog.json");
	const definition = { schemaVersion: 1, socketPath: join(sockets, "owner.sock"), stateRoot: join(root, "derived"), defaults, qmd, stores };
	await writeFile(catalog, JSON.stringify(definition), { mode: 0o600 });
	host = await startSharedHost(catalog);
	const ready = async (adapter: QmdAdapter) => {
		const receipt = await adapter.startupReconcile([...adapter.config.stores.values()]);
		assert.equal((await job(adapter, String(receipt.refreshId))).state, "succeeded");
	};
	await Promise.all([...host.adapters.values()].map(ready));
	const project = async (name: string, mixed = false, extra: Record<string, unknown> = {}) => {
		const projectRoot = join(root, name), configDir = join(projectRoot, ".pi", "markdown-datastore");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		const selected: Record<string, unknown> = { book: { shared: { catalog, store: "notebook" } }, records: { shared: { catalog, store: "archive" } }, ...extra };
		if (mixed) {
			await mkdir(join(projectRoot, "private"), { mode: 0o700 }); await writeFile(join(projectRoot, "private", "copper.md"), "Copper private note.\n");
			selected.personal = { root: "private", include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } };
		}
		const configPath = join(configDir, "config.json");
		await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults, qmd: { ...qmd, enabled: mixed }, stores: selected }), { mode: 0o600 });
		const config = await loadMarkdownDatastoreConfig(projectRoot, configPath);
		const privateStores = new Map([...config.stores].filter(([, store]) => !store.shared));
		const privateConfig = { ...config, stores: privateStores };
		const local = mixed ? new QmdAdapter(privateConfig, await discoverQmdBinding(privateConfig)) : undefined;
		if (local) await ready(local);
		const clients = new Map([...config.stores].filter(([, store]) => store.shared).map(([alias, store]) => [alias, new SharedIndexClient(store.shared!)]));
		const service = new MarkdownDatastoreService(config, undefined, local, clients); services.push(service);
		return { config, service, clients, local };
	};
	return { root, sockets, catalog, definition, project, ready, job, entered, behavior, release, trackChild, stopChild,
		get host() { return host!; },
		stopHost: async () => { await host?.close(); host = undefined; },
		restart: async () => { await host?.close(); host = undefined; host = await startSharedHost(catalog); return host; },
	};
}

test("one catalog serves notebook/archive and mixed projects; a second endpoint cannot steal an index", async t => {
	const f = await fixture(t), mixed = await f.project("mixed", true), sharedOnly = await f.project("shared");
	for (const store of ["book", "records", "personal"]) {
		const result = await mixed.service.search({ store, query: "copper", mode: "lexical", freshness: "require-current-lexical" });
		assert.equal(result.data.returned, 1); assert.equal(result.data.hits[0]!.note.store, store);
	}
	assert.equal((await sharedOnly.service.search({ store: "book", query: "copper" })).data.returned, 1);
	const status = await mixed.service.status({});
	for (const entry of status.data.stores) {
		assert.equal(entry.capabilities.search.lexical.state, "ready");
		assert.equal(entry.capabilities.search.semantic.state, "degraded");
		assert.equal(entry.capabilities.search.semantic.reasonCode, "STALE_INDEX");
		assert.equal(entry.sourceReconciliation.state, "succeeded");
		assert.deepEqual(entry.sourceReconciliation.job!.stores, [entry.store]);
	}
	await assert.rejects(mixed.service.refresh({ action: "cancel", refreshId: "0".repeat(32) }), { code: "INVALID_NOTE_REF" });
	await assert.rejects(lstat(sharedOnly.config.stateRoot), { code: "ENOENT" });
	for (const root of [join(f.root, "notebook"), mixed.config.stores.get("personal")!.root]) {
		for (let index = 0; index < 10; index += 1) await writeFile(join(root, `budget-${index}.md`), "# Budget\nCopper budget " + "words ".repeat(500));
	}
	for (const [store, adapter] of [["book", f.host.adapters.get("notebook")!], ["personal", mixed.local!]] as const) {
		const receipt = await mixed.service.refresh({ store, mode: "lexical" });
		assert.equal((await f.job(adapter, String(receipt.data.qmd.refreshId))).state, "succeeded");
		const bounded = await mixed.service.search({ store, query: "budget", mode: "lexical", includeContent: true, limit: 20 });
		assert.equal(bounded.bounds.truncated, true);
		assert.ok(bounded.data.returned < 10);
		assert.ok(bounded.bounds.returnedBytes <= mixed.config.defaults.maxResultBytes);
		assert.ok(bounded.warnings.some(warning => warning.code === "RESULT_LIMIT_EXCEEDED"));
	}
	const alternate = join(f.root, "alternate.json");
	await writeFile(alternate, JSON.stringify({ ...f.definition, socketPath: join(f.sockets, "alternate.sock") }), { mode: 0o600 });
	await assert.rejects(startSharedHost(alternate), { code: "STORE_UNAVAILABLE" });
	assert.equal((await mixed.service.search({ store: "book", query: "notebook" })).data.returned, 1);
});

test("held shared maintenance coalesces, serializes, survives detach and distinguishes explicit cancellation", async t => {
	const f = await fixture(t), left = await f.project("left");
	const right = await f.project("right", false, { book: undefined, "other-book": { shared: { catalog: f.catalog, store: "notebook" } } });
	const adapter = f.host.adapters.get("notebook")!;
	const log = () => readFile(join(adapter.root, "calls.log"), "utf8");
	const before = (await log()).split("\n").filter(item => item === "update").length;
	await f.behavior(adapter, { updateGate: "held-update" });
	const first = await left.service.refresh({ store: "book", mode: "lexical" });
	const id = String(first.data.qmd.refreshId); await f.entered(adapter, "held-update", id);
	assert.deepEqual(first.data.qmd.stores, ["book"]);
	assert.deepEqual(adapter.activity().jobs.find(item => item.refreshId === id)!.stores, ["notebook"]);
	const repeated = await right.service.refresh({ store: "other-book", mode: "lexical" });
	assert.equal(repeated.data.qmd.refreshId, id); assert.equal(repeated.data.qmd.coalesced, true);
	assert.deepEqual(repeated.data.qmd.stores, ["other-book"]);
	const queued = await right.service.refresh({ store: "other-book", mode: "semantic" });
	assert.notEqual(queued.data.qmd.refreshId, id);
	assert.equal((await log()).split("\n").filter(item => item === "update").length, before + 1);
	await left.service.shutdown();
	assert.equal((await right.clients.get("other-book")!.activity()).jobs.find(item => item.refreshId === id)!.state, "running");
	await right.service.refresh({ action: "cancel", refreshId: String(queued.data.qmd.refreshId) });
	await f.release(adapter, "held-update");
	assert.equal((await f.job(adapter, id)).state, "succeeded");
	assert.equal((await f.job(adapter, String(queued.data.qmd.refreshId))).state, "cancelled");
	await f.behavior(adapter, { updateGate: "cancel-update" });
	const active = await right.service.refresh({ store: "other-book", mode: "lexical" });
	await f.entered(adapter, "cancel-update", String(active.data.qmd.refreshId));
	await right.service.refresh({ action: "cancel", refreshId: String(active.data.qmd.refreshId) });
	assert.equal((await f.job(adapter, String(active.data.qmd.refreshId))).state, "cancelled");
	await f.behavior(adapter, {});
	const healthy = await right.service.refresh({ store: "other-book", mode: "lexical" });
	assert.equal((await f.job(adapter, String(healthy.data.qmd.refreshId))).state, "succeeded");
});

test("reader waiter cancellation leaves shared jobs alone; restart recovers receipts and rejects stale generations", async t => {
	const f = await fixture(t), project = await f.project("caller");
	const adapter = f.host.adapters.get("notebook")!;
	await f.behavior(adapter, { searchGate: "held-search" });
	const controller = new AbortController();
	const search = project.service.search({ store: "book", query: "copper", mode: "lexical" }, controller.signal);
	const cancelled = assert.rejects(search, { code: "CANCELLED" });
	await f.entered(adapter, "held-search"); controller.abort(); await cancelled;
	await f.behavior(adapter, {});
	assert.equal((await project.service.search({ store: "book", query: "copper" })).data.returned, 1);
	await f.behavior(adapter, { updateGate: "interrupted-update" });
	const receipt = await project.service.refresh({ store: "book", mode: "lexical" });
	const id = String(receipt.data.qmd.refreshId); await f.entered(adapter, "interrupted-update", id);
	const oldGeneration = f.host.generation, revision = f.host.catalog.stores.get("notebook")!.definitionRevision;
	await f.behavior(adapter, {});
	await f.restart();
	assert.notEqual(f.host.generation, oldGeneration);
	const recovered = f.host.adapters.get("notebook")!;
	assert.equal((await f.job(recovered, id)).state, "succeeded");
	await f.ready(recovered);
	const socket = createConnection(f.definition.socketPath);
	const stale = new Promise<any>((resolve, reject) => {
		socket.once("error", reject); attachSharedParser(socket, reply => resolve(reply), reject);
		socket.once("connect", () => socket.write(encodeSharedMessage({ version: 1, operation: "activity", requestId: requestId(), generation: oldGeneration, store: "notebook", definitionRevision: revision })));
	});
	try { assert.equal((await stale).error.code, "STORE_UNAVAILABLE"); } finally { socket.destroy(); }
	assert.equal((await project.service.read({ store: "book", note: { store: "book", path: "copper.md" } })).data.note.store, "book");
});

test("shared backend failure keeps failed receipts and rebuilds through the common maintenance unit", async t => {
	const f = await fixture(t), project = await f.project("recovery");
	const adapter = f.host.adapters.get("notebook")!;
	await f.behavior(adapter, { updateError: true });
	const failed = await project.service.refresh({ store: "book", mode: "lexical" });
	assert.equal((await f.job(adapter, String(failed.data.qmd.refreshId))).state, "failed");
	await f.behavior(adapter, {});
	await writeFile(join(f.root, "notebook", "new.md"), "Copper newly recovered source.\n");
	const retry = await project.service.refresh({ store: "book", mode: "lexical" });
	assert.equal((await f.job(adapter, String(retry.data.qmd.refreshId))).state, "succeeded");
	assert.equal(adapter.activity().jobs.find(item => item.refreshId === failed.data.qmd.refreshId)!.state, "failed");
	const result = await project.service.search({ store: "book", query: "copper", mode: "lexical", freshness: "require-current-lexical" });
	assert.deepEqual(result.data.hits.map(item => item.path).sort(), ["copper.md", "new.md"]);
});

test("cancelling a receipt waiter does not cancel already accepted shared maintenance", async t => {
	const f = await fixture(t), caller = await f.project("waiter"), observer = await f.project("observer");
	const adapter = f.host.adapters.get("notebook")!;
	await f.behavior(adapter, { updateGate: "accepted-job" });
	let accepted!: (value: Record<string, unknown>) => void, releaseReply!: () => void;
	const acceptedJob = new Promise<Record<string, unknown>>(resolve => { accepted = resolve; });
	const heldReply = new Promise<void>(resolve => { releaseReply = resolve; });
	const original = adapter.startLexicalRefresh.bind(adapter);
	adapter.startLexicalRefresh = async (stores, ownership) => { const receipt = await original(stores, ownership); accepted(receipt); await heldReply; return receipt; };
	const controller = new AbortController();
	try {
		const request = caller.service.refresh({ store: "book", mode: "lexical" }, controller.signal);
		const cancellation = assert.rejects(request, { code: "CANCELLED" });
		const receipt = await Promise.race([acceptedJob, request.then(() => { throw new Error("Receipt was not held"); })]);
		const id = String(receipt.refreshId); await f.entered(adapter, "accepted-job", id);
		controller.abort(); await cancellation;
		assert.equal((await observer.clients.get("book")!.activity()).jobs.find(item => item.refreshId === id)!.state, "running");
		releaseReply(); await f.release(adapter, "accepted-job");
		assert.equal((await f.job(adapter, id)).state, "succeeded");
	} finally { releaseReply(); adapter.startLexicalRefresh = original; }
});

test("operator restart after abrupt service exit reclaims ownership and recovers the same receipt", async t => {
	const f = await fixture(t), project = await f.project("crash-caller");
	const previous = f.host.adapters.get("notebook")!;
	await f.stopHost();
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../src/shared-service-main.ts", import.meta.url)), "--catalog", f.catalog], { stdio: ["ignore", "pipe", "pipe"] });
	f.trackChild(child);
	let errors = "";
	child.stderr.on("data", value => { errors += String(value); });
	const generation = await new Promise<string>((resolve, reject) => {
		let output = "";
		child.once("error", reject); child.once("exit", code => reject(new Error(`Service exited before readiness: ${code}: ${errors}`)));
		child.stdout.on("data", value => { output += String(value); if (output.includes("\n")) resolve(output.split("\n")[0]!); });
	});
	assert.match(generation, /^gen-/);
	await f.behavior(previous, { updateGate: "crash-update" });
	const receipt = await project.service.refresh({ store: "book", mode: "lexical" });
	const id = String(receipt.data.qmd.refreshId); await f.entered(previous, "crash-update", id);
	const workers = (await readdir(join(previous.root, "owner"))).flatMap(name => { const match = /^worker-([0-9]+)-/.exec(name); return match ? [Number(match[1])] : []; });
	assert.ok(workers.length > 0);
	await f.stopChild(child);
	// Non-child workers exit on owner-pipe EOF. Observe that completion; no deadline or retry budget.
	for (const pid of workers) {
		for (;;) {
			try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
			await nextTurn();
		}
	}
	assert.match((await project.service.read({ store: "book", note: { store: "book", path: "copper.md" } })).data.content!, /Copper notebook/);
	await f.behavior(previous, {});
	await f.restart();
	assert.notEqual(f.host.generation, generation);
	const recovered = f.host.adapters.get("notebook")!;
	assert.equal((await f.job(recovered, id)).state, "succeeded");
	await f.ready(recovered);
	assert.equal((await project.service.search({ store: "book", query: "copper", mode: "lexical", freshness: "require-current-lexical" })).data.returned, 1);
});

test("replacing a source root at the same path invalidates old shared attachments", async t => {
	const f = await fixture(t), old = await f.project("old-root");
	const revision = old.config.stores.get("book")!.shared!.definitionRevision;
	await f.stopHost();
	await rename(join(f.root, "notebook"), join(f.root, "retired-notebook"));
	await mkdir(join(f.root, "notebook"), { mode: 0o700 });
	await writeFile(join(f.root, "notebook", "copper.md"), "Copper replacement source.\n");
	await f.restart();
	await f.ready(f.host.adapters.get("notebook")!);
	assert.notEqual(f.host.catalog.stores.get("notebook")!.definitionRevision, revision);
	await assert.rejects(old.service.search({ store: "book", query: "copper", mode: "lexical" }), { code: "STORE_UNAVAILABLE" });
	const fresh = await f.project("new-root");
	assert.equal((await fresh.service.search({ store: "book", query: "copper", mode: "lexical", freshness: "require-current-lexical" })).data.returned, 1);
});

test("canonical definitions, not root paths or backend-local collection names, identify shared datastores", async t => {
	const f = await fixture(t);
	await f.stopHost();
	f.definition.stores.filtered = { ...(f.definition.stores.notebook as object), exclude: ["archived/**"] };
	await writeFile(f.catalog, JSON.stringify(f.definition), { mode: 0o600 });
	await f.restart(); await Promise.all([...f.host.adapters.values()].map(f.ready));
	const project = await f.project("namespaces", true, { "second-book": { shared: { catalog: f.catalog, store: "filtered" } } });
	assert.equal(project.config.stores.get("book")!.root, project.config.stores.get("second-book")!.root);
	assert.notEqual(project.config.stores.get("book")!.shared!.definitionRevision, project.config.stores.get("second-book")!.shared!.definitionRevision);
	assert.notEqual(f.host.adapters.get("notebook")!.root, f.host.adapters.get("filtered")!.root);
	for (const store of ["book", "records", "second-book", "personal"]) assert.equal((await project.service.search({ store, query: "copper", mode: "lexical" })).data.returned, 1);
});
