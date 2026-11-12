import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";

function coordinator(dir: string) {
	return new MaintenanceCoordinator(join(dir, "jobs.json"), () => new Set(["memory"]));
}

test("ledger keeps progress, capacity, validation, and explicit cancel", async (t) => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "datastore-ledger-")));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const progress = coordinator(dir);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let reported!: () => void;
	const sawReport = new Promise<void>((resolve) => { reported = resolve; });
	progress.register("metadata", async (_job, _signal, report) => {
		report("updating", { documentsCompleted: 3, sourceBytesCompleted: 9, documentsTotal: 8, sourceBytesTotal: 40 });
		report("embedding", { phase: "embedding", documents: { completed: 1, total: 5 }, chunks: { completed: 2, total: 4 }, errors: 1 });
		reported();
		await gate;
		return { generation: "meta-1" };
	});
	const job = await progress.enqueue("metadata", ["memory"], "explicit-maintenance");
	await sawReport;
	assert.equal(progress.get(String(job.refreshId))?.progress.chunksCompleted, 2);
	assert.equal(progress.get(String(job.refreshId))?.progress.documentsTotal, 5);
	assert.equal(progress.get(String(job.refreshId))?.progress.sourceBytesTotal, 40);
	release();
	await progress.settled();
	const names = Array.from({ length: 21 }, (_item, index) => `s${index}`);
	const full = new MaintenanceCoordinator(join(dir, "full", "jobs.json"), () => new Set(names));
	let hold!: () => void;
	const blocked = new Promise<void>((resolve) => { hold = resolve; });
	full.register("metadata", async () => { await blocked; return { generation: "held" }; });
	for (let index = 0; index < 20; index += 1) await full.enqueue("metadata", [names[index]], "explicit-maintenance");
	await assert.rejects(full.enqueue("metadata", [names[20]], "explicit-maintenance"), { code: "RESULT_LIMIT_EXCEEDED" });
	hold();
	await full.settled();
	await mkdir(join(dir, "bad"));
	const bad = coordinator(join(dir, "bad"));
	await writeFile(bad.jobsPath, JSON.stringify({ version: 1, jobs: [{ version: 1, refreshId: "a".repeat(32), key: "metadata:memory", mode: "metadata", stores: ["memory"], ownership: "explicit-maintenance", state: "succeeded", phase: "succeeded", updatedAt: new Date().toISOString(), progress: { documentsCompleted: 0, sourceBytesCompleted: 0, chunksCompleted: 0, embeddingBytesCompleted: 0, errors: 0 } }] }));
	await assert.rejects(bad.ensureLoaded(), { code: "INDEX_CORRUPT" });
	const cancel = coordinator(join(dir, "cancel"));
	let finish!: () => void;
	const running = new Promise<void>((resolve) => { finish = resolve; });
	let started!: () => void;
	const holding = new Promise<void>((resolve) => { started = resolve; });
	cancel.register("metadata", async (_job, signal) => { started(); await Promise.race([running, new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))]); return { generation: "meta-" + "ab".repeat(16) }; });
	const runningJob = await cancel.enqueue("metadata", ["memory"], "explicit-maintenance");
	await holding;
	assert.equal(cancel.get(String(runningJob.refreshId))?.state, "running");
	await cancel.cancel(String(runningJob.refreshId));
	cancel.shutdown();
	finish();
	await cancel.settled();
	assert.equal(cancel.get(String(runningJob.refreshId))?.state, "cancelled");
	const failing = coordinator(join(dir, "fail"));
	let entered!: () => void;
	const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
	let finishFail!: () => void;
	const finishGate = new Promise<void>((resolve) => { finishFail = resolve; });
	failing.register("metadata", async () => { entered(); await finishGate; return { generation: "meta-" + "cd".repeat(16) }; });
	const failingJob = await failing.enqueue("metadata", ["memory"], "explicit-maintenance");
	await enteredGate;
	await chmod(join(dir, "fail"), 0o500);
	finishFail();
	await failing.settled();
	await chmod(join(dir, "fail"), 0o700);
	assert.equal(failing.get(String(failingJob.refreshId))?.state, "failed");
	assert.equal(failing.get(String(failingJob.refreshId))?.errorCode, "INDEX_CORRUPT");
});

test("a lone capacity rejection does not emit an unhandled rejection", async () => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "datastore-lone-reject-")));
	const names = Array.from({ length: 21 }, (_item, index) => `s${index}`);
	const owner = new MaintenanceCoordinator(join(dir, "jobs.json"), () => new Set(names));
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	owner.register("metadata", async () => { await held; return { generation: "meta-" + "ab".repeat(16) }; });
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => { unhandled.push(error); };
	process.on("unhandledRejection", onUnhandled);
	try {
		for (let index = 0; index < 20; index += 1) await owner.enqueue("metadata", [names[index]], "explicit-maintenance");
		await assert.rejects(owner.enqueue("metadata", [names[20]], "explicit-maintenance"), { code: "RESULT_LIMIT_EXCEEDED" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally { process.off("unhandledRejection", onUnhandled); release(); owner.shutdown(); await owner.settled(); await rm(dir, { recursive: true, force: true }); }
});

test("a failed first admission rejects every coalesced caller and starts no runner", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-admit-fail-")));
	const owner = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["a"]));
	let starts = 0;
	owner.register("metadata", async () => { starts += 1; return { generation: "meta-" + "a".repeat(32) }; });
	await owner.ensureLoaded();
	await chmod(root, 0o500);
	const calls = await Promise.allSettled([owner.enqueue("metadata", ["a"], "explicit-maintenance"), owner.enqueue("metadata", ["a"], "explicit-maintenance")]);
	owner.shutdown();
	await owner.settled();
	assert.deepEqual(calls.map((call) => call.status), ["rejected", "rejected"]);
	assert.equal(starts, 0);
	await chmod(root, 0o700);
	await rm(root, { recursive: true, force: true });
});

test("queued cancel stays cancelled after a held predecessor is released", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-queue-cancel-")));
	const owner = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["a", "b"]));
	let started!: () => void;
	const entered = new Promise<void>((resolve) => { started = resolve; });
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	owner.register("metadata", async (job, signal) => {
		if (job.stores.includes("a")) { started(); await new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); held.then(() => undefined); }); }
		return { generation: "meta-" + "b".repeat(32) };
	});
	await owner.enqueue("metadata", ["a"], "explicit-maintenance");
	await entered;
	const queued = await owner.enqueue("metadata", ["b"], "explicit-maintenance");
	const durable = owner.persisted(String(queued.refreshId));
	await owner.cancel(String(queued.refreshId));
	await durable;
	assert.equal(owner.get(String(queued.refreshId))?.state, "cancelled");
	owner.shutdown();
	release();
	await owner.settled();
	assert.equal(owner.get(String(queued.refreshId))?.state, "cancelled");
	const disk = JSON.parse(await readFile(join(root, "jobs.json"), "utf8")) as { jobs: { refreshId: string; state: string }[] };
	assert.equal(disk.jobs.find((job) => job.refreshId === queued.refreshId)?.state, "cancelled");
	await rm(root, { recursive: true, force: true });
});
