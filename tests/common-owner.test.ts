import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireIndexOwnership } from "../src/index-ownership.ts";
import { createMarkdownDatastoreExtension } from "../src/index.ts";
import { adoptLegacyApplicationJobs, MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { prepareQmdStateDirectory, qmdApplicationDirectory } from "../src/qmd-adapter.ts";

function harness(project: string) {
	const emitter = new EventEmitter();
	const handlers = new Map<string, Function[]>();
	const tools: any[] = [];
	const pi: any = {
		events: { emit: (channel: string, data: unknown) => emitter.emit(channel, data), on: (channel: string, handler: (data: unknown) => void) => { emitter.on(channel, handler); return () => emitter.off(channel, handler); } },
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: any) { tools.push(tool); },
		appendEntry() {},
	};
	const ctx: any = { cwd: project, isProjectTrusted: () => true, ui: { setStatus() {} } };
	return { pi, tools, fire: async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); } };
}

test("one coordinator keeps a metadata receipt as qmd appears and disappears", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-common-owner-")));
	const jobs = join(root, "jobs.json");
	const stores = () => new Set(["notes"]);
	const coordinator = new MaintenanceCoordinator(jobs, stores);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	coordinator.register("metadata", async (_job, signal) => { await new Promise<void>((done, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); gate.then(done); }); return { generation: "meta-" + "ab".repeat(16) }; });
	const receipt = await coordinator.enqueue("metadata", ["notes"], "explicit-maintenance");
	const qmd = { coordinator, shutdown: async () => undefined };
	for (let attempt = 0; attempt < 20 && coordinator.get(String(receipt.refreshId))?.state !== "running"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(coordinator.get(String(receipt.refreshId))?.state, "running");
	await qmd.shutdown();
	assert.equal(coordinator.get(String(receipt.refreshId))?.state, "running");
	await coordinator.cancel(String(receipt.refreshId));
	await coordinator.settled();
	assert.equal(coordinator.get(String(receipt.refreshId))?.state, "cancelled");
	const returned = { coordinator, shutdown: async () => undefined };
	await returned.shutdown();
	const reopened = new MaintenanceCoordinator(jobs, stores);
	await reopened.ensureLoaded();
	assert.equal(reopened.get(String(receipt.refreshId))?.state, "cancelled");
	reopened.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("a second private owner is refused and a legacy application ledger is adopted", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-legacy-owner-")));
	await prepareQmdStateDirectory(root);
	const first = await acquireIndexOwnership(root);
	await assert.rejects(acquireIndexOwnership(root), { code: "STORE_UNAVAILABLE" });
	await first.release();
	const config = { stateRoot: root, stores: new Map([["notes", { name: "notes" }]]) } as any;
	const legacy = join(qmdApplicationDirectory(config, "2.8.3"), "jobs.json");
	const legacyOwner = new MaintenanceCoordinator(legacy, () => new Set(["notes"]));
	legacyOwner.register("metadata", async () => ({ generation: "meta-" + "cd".repeat(16) }));
	const saved = await legacyOwner.enqueue("metadata", ["notes"], "explicit-maintenance");
	await legacyOwner.settled();
	legacyOwner.shutdown();
	const stable = join(root, "jobs.json");
	await adoptLegacyApplicationJobs(root, stable, new Set(["notes"]));
	const adopted = new MaintenanceCoordinator(stable, () => new Set(["notes"]));
	await adopted.ensureLoaded();
	assert.equal(adopted.get(String(saved.refreshId))?.state, "succeeded");
	adopted.shutdown();
	const unseen = await realpath(await mkdtemp(join(tmpdir(), "datastore-unseen-ledger-")));
	await prepareQmdStateDirectory(unseen);
	const hidden = join(unseen, "qmd-public-no-binding", "jobs.json");
	const writer = new MaintenanceCoordinator(hidden, () => new Set(["notes"]));
	writer.register("metadata", async () => ({ generation: "meta-" + "ef".repeat(16) }));
	const hiddenReceipt = await writer.enqueue("metadata", ["notes"], "explicit-maintenance");
	await writer.settled();
	writer.shutdown();
	const stableUnseen = join(unseen, "jobs.json");
	await adoptLegacyApplicationJobs(unseen, stableUnseen, new Set(["notes"]));
	const recovered = new MaintenanceCoordinator(stableUnseen, () => new Set(["notes"]));
	await recovered.ensureLoaded();
	assert.equal(recovered.get(String(hiddenReceipt.refreshId))?.state, "succeeded");
	recovered.shutdown();
	await mkdir(join(unseen, "qmd-public-other"), { mode: 0o700 });
	await writeFile(join(unseen, "qmd-public-other", "jobs.json"), await (await import("node:fs/promises")).readFile(hidden), { mode: 0o600 });
	await rm(stableUnseen);
	await assert.rejects(adoptLegacyApplicationJobs(unseen, stableUnseen, new Set(["notes"])), { code: "INDEX_CORRUPT" });
	await assert.rejects((await import("node:fs/promises")).lstat(stableUnseen), { code: "ENOENT" });
	await rm(root, { recursive: true, force: true });
	await rm(unseen, { recursive: true, force: true });
});

test("extension status keeps the metadata receipt when qmd drops and returns", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-owner-ext-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notes = join(root, "notes");
	const dir = join(root, ".pi", "markdown-datastore");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	await mkdir(notes);
	await writeFile(join(notes, "alpha.md"), "See [[beta]].\n");
	await writeFile(join(notes, "beta.md"), "Target.\n");
	await writeFile(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: true, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { memory: { root: "notes", include: ["**/*.md"], exclude: [], maxFileBytes: 200000, search: { defaultMode: "lexical", qmdCollection: "memory" } } } }), { mode: 0o600 });
	let available = true;
	const app = harness(root);
	createMarkdownDatastoreExtension({ projectRoot: root, createQmd: async () => { if (!available) throw new Error("unavailable"); return { binding: { version: "2.8.3" }, startupReconcile: async () => undefined, shutdown: async () => undefined } as any; } })(app.pi);
	await app.fire("session_start");
	t.after(() => app.fire("session_shutdown"));
	const refresh = app.tools.find((tool) => tool.name === "datastore_refresh");
	const status = app.tools.find((tool) => tool.name === "datastore_status");
	await refresh.execute("1", { store: "memory", mode: "metadata" }, new AbortController().signal);
	let first: any;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		first = JSON.parse((await status.execute("2", { store: "memory" }, new AbortController().signal)).content[0].text);
		if (first.data.stores[0].capabilities.metadata.progress.job?.refreshId) break;
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
	const id = first.data.stores[0].capabilities.metadata.progress.job?.refreshId;
	assert.ok(id, JSON.stringify(first.data.stores[0].capabilities.metadata));
	assert.match(id, /^[0-9a-f]{32}$/);
	available = false;
	await app.fire("session_start");
	const dropped = JSON.parse((await status.execute("3", { store: "memory" }, new AbortController().signal)).content[0].text);
	assert.equal(dropped.data.stores[0].capabilities.metadata.progress.job.refreshId, id);
	available = true;
	await app.fire("session_start");
	const returned = JSON.parse((await status.execute("4", { store: "memory" }, new AbortController().signal)).content[0].text);
	assert.equal(returned.data.stores[0].capabilities.metadata.progress.job.refreshId, id);
});
