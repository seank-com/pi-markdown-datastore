import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
		report("embedding", { phase: "embedding", chunks: { completed: 2, total: 4 }, errors: 1 });
		reported();
		await gate;
		return { generation: "meta-1" };
	});
	const job = await progress.enqueue("metadata", ["memory"], "explicit-maintenance");
	await sawReport;
	assert.equal(progress.get(String(job.refreshId))?.progress.chunksCompleted, 2);
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
	cancel.register("metadata", async (_job, signal) => { await Promise.race([running, new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))]); return { generation: "x" }; });
	const runningJob = await cancel.enqueue("metadata", ["memory"], "explicit-maintenance");
	await new Promise((resolve) => setImmediate(resolve));
	await cancel.cancel(String(runningJob.refreshId));
	cancel.shutdown();
	finish();
	await cancel.settled();
	assert.equal(cancel.get(String(runningJob.refreshId))?.state, "cancelled");
});
