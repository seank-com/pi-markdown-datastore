import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { MetadataIndex, reconcileChanged, registerMetadata } from "../src/metadata-index.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { startSharedHost } from "../src/shared-host.ts";
import { loadSharedCatalog } from "../src/shared-catalog.ts";

async function store() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stage-b-")));
	const notes = join(root, "notes");
	const state = join(root, "state");
	await mkdir(notes);
	await mkdir(state, { mode: 0o700 });
	const configDir = join(root, ".pi", "markdown-datastore");
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	await chmod(join(root, ".pi"), 0o755);
	await chmod(configDir, 0o700);
	const configPath = join(configDir, "config.json");
	await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notes: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } } } }), { mode: 0o600 });
	const config = await loadMarkdownDatastoreConfig(root, configPath);
	return { root, notes, state, config };
}

test("cancelled path scope is not replayed and a rebuild receipt reloads", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stage-b-own-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const coordinator = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["a", "b"]));
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { coordinator.register("metadata", async (job) => { if (job.stores[0] === "a") { resolve(); await new Promise<void>((done) => { release = done; }); } }); });
	coordinator.notePaths("a", ["first.md"]);
	await coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	await entered;
	coordinator.notePaths("b", ["cancelled.md"]);
	const cancelled = await coordinator.enqueue("metadata", ["b"], "explicit-maintenance");
	await coordinator.cancel(String(cancelled.refreshId));
	coordinator.notePaths("b", ["newer.md"]);
	const newer = await coordinator.enqueue("metadata", ["b"], "explicit-maintenance");
	release();
	await coordinator.settled();
	assert.equal(coordinator.get(String(cancelled.refreshId))?.state, "cancelled");
	assert.equal(coordinator.get(String(newer.refreshId))?.state, "succeeded");
	assert.deepEqual(coordinator.get(String(newer.refreshId))?.paths, ["newer.md"]);
	const rebuild = new MaintenanceCoordinator(join(root, "rebuild.json"), () => new Set(["a"]));
	await rebuild.enqueue("metadata", ["a"], "explicit-maintenance", undefined, "rebuild");
	rebuild.shutdown();
	await rebuild.settled();
	const reopened = new MaintenanceCoordinator(join(root, "rebuild.json"), () => new Set(["a"]));
	await reopened.ensureLoaded();
	assert.equal(reopened.jobs()[0]?.intent, "rebuild");
	reopened.shutdown();
});

test("a follow-up receipt is durable before the running job finishes", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stage-b-follow-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const coordinator = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["notes"]));
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { coordinator.register("metadata", async () => { resolve(); await new Promise<void>((done) => { release = done; }); }); });
	coordinator.notePaths("notes", ["a.md"]);
	const first = await coordinator.enqueue("metadata", ["notes"], "explicit-maintenance");
	await entered;
	coordinator.notePaths("notes", ["b.md"]);
	const follow = await coordinator.enqueue("metadata", ["notes"], "explicit-maintenance");
	assert.notEqual(follow.refreshId, first.refreshId);
	assert.equal(coordinator.get(String(follow.refreshId))?.state, "queued");
	await coordinator.cancel(String(follow.refreshId));
	release();
	await coordinator.settled();
	assert.equal(coordinator.get(String(follow.refreshId))?.state, "cancelled");
	assert.equal(coordinator.jobs().some((job) => job.paths?.includes("b.md") && job.state === "succeeded"), false);
});

test("shutdown during reconciliation settles without finishing the recovered job", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stage-b-close-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const coordinator = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["notes"]));
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { coordinator.register("metadata", async (_job, signal) => { resolve(); await new Promise<void>((_done, reject) => { release = () => reject(signal.reason); signal.addEventListener("abort", () => reject(signal.reason)); }); }); });
	const receipt = await coordinator.enqueue("metadata", ["notes"], "startup-reconciliation");
	const waiting = coordinator.persisted(String(receipt.refreshId));
	await entered;
	coordinator.shutdown();
	release();
	await waiting;
	await coordinator.settled();
	assert.equal(coordinator.get(String(receipt.refreshId))?.state, "queued");
});

test("shutdown disposes the cycle before its callback can run or rearm", async () => {
	const coordinator = new MaintenanceCoordinator(join(tmpdir(), `cycle-${Date.now()}.json`), () => new Set());
	let runs = 0;
	let schedules = 0;
	let stored: (() => void) | undefined;
	coordinator.startCycle(async () => { runs += 1; }, 300_000, ((callback: () => void) => {
		schedules += 1;
		stored = callback;
		return { unref() {}, ref() {} } as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout);
	assert.equal(schedules, 1);
	coordinator.shutdown();
	stored?.();
	await coordinator.settled();
	assert.equal(runs, 0);
	assert.equal(schedules, 1);
	await rm(join(tmpdir(), `cycle-${Date.now()}.json`), { force: true });
});

test("a failed lexical reconciliation stays due after the graph is current", async (t) => {
	const fixture = await store();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await writeFile(join(fixture.notes, "a.md"), "one\n");
	const index = new MetadataIndex(fixture.state);
	const storeConfig = fixture.config.stores.get("notes")!;
	await index.refresh(storeConfig);
	const coordinator = new MaintenanceCoordinator(join(fixture.state, "jobs.json"), () => new Set(["notes"]));
	registerMetadata(coordinator, new Map([["notes", index]]), fixture.config.stores);
	let lexical = 0;
	coordinator.register("lexical", async () => { lexical += 1; throw new Error("qmd failed"); });
	coordinator.noteQmd("notes");
	await reconcileChanged(coordinator, new Map([["notes", index]]), fixture.config.stores);
	assert.equal(lexical, 1);
	await reconcileChanged(coordinator, new Map([["notes", index]]), fixture.config.stores);
	assert.equal(lexical, 2);
	assert.equal(coordinator.jobs().filter((job) => job.mode === "lexical" && job.state === "failed").length, 2);
});

test("a shared owner runs the injected clock and graph work before qmd", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "stage-b-shared-")));
	const socketDir = join(root, "sock");
	await mkdir(socketDir, { mode: 0o700 });
	const notes = join(root, "notes");
	const state = join(root, "state");
	await mkdir(notes);
	await mkdir(state, { mode: 0o700 });
	await writeFile(join(notes, "a.md"), "one\n");
	const catalogPath = join(root, "catalog.json");
	await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, socketPath: join(socketDir, "s.sock"), stateRoot: state, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notebook: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notebook" } } } }), { mode: 0o600 });
	let callback: (() => void) | undefined;
	const host = await startSharedHost(catalogPath, { schedule: ((stored: () => void) => { callback = stored; return { unref() {}, ref() {} } as ReturnType<typeof setTimeout>; }) as typeof setTimeout });
	t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
	const coordinator = host.coordinators.get("notebook")!;
	let sawMetadata = false;
	coordinator.register("lexical", async () => { sawMetadata = coordinator.jobs().some((job) => job.mode === "metadata" && job.state === "succeeded"); });
	await writeFile(join(notes, "a.md"), "two\n");
	callback?.();
	await coordinator.settled();
	assert.equal(sawMetadata, true);
	const catalog = await loadSharedCatalog(catalogPath);
	assert.equal(catalog.stores.has("notebook"), true);
});

test("bad paths are rejected and a late path gets the follow-up receipt", async (t) => {
	const fixture = await store();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await writeFile(join(fixture.notes, "a.md"), "one\n");
	const coordinator = new MaintenanceCoordinator(join(fixture.state, "jobs.json"), () => new Set(["notes"]));
	const indexes = new Map([["notes", new MetadataIndex(fixture.state)]]);
	registerMetadata(coordinator, indexes, fixture.config.stores);
	const service = new MarkdownDatastoreService(fixture.config);
	service.bindMetadata(coordinator, indexes);
	t.after(() => service.shutdown());
	await assert.rejects(service.refresh({ action: "start", store: "notes", mode: "metadata", paths: ["../a.md"] }), { code: "INVALID_NOTE_REF" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	coordinator.register("metadata", async () => { await gate; });
	const first = await service.refresh({ action: "start", store: "notes", mode: "metadata", paths: ["a.md"] });
	const second = service.refresh({ action: "start", store: "notes", mode: "metadata", paths: ["a.md"] });
	release();
	const followed = await second;
	assert.notEqual(followed.data.qmd.refreshId, first.data.qmd.refreshId);
	await coordinator.persisted(String(followed.data.qmd.refreshId));
	assert.equal(coordinator.get(String(followed.data.qmd.refreshId))?.state, "succeeded");
});
