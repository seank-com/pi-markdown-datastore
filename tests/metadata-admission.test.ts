import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";

const generation = `meta-${"a".repeat(32)}`;
async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "metadata-admission-")));
	await chmod(root, 0o700);
	const coordinator = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["a", "b"]));
	const releases: (() => void)[] = [];
	t.after(async () => {
		await chmod(root, 0o700);
		for (const release of releases) release();
		coordinator.shutdown();
		await coordinator.settled();
		await rm(root, { recursive: true, force: true });
	});
	return { root, coordinator, releases };
}

test("paths arriving during initial admission are covered by their durable receipt", async (t) => {
	const { root, coordinator, releases } = await fixture(t);
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	releases.push(release);
	coordinator.register("metadata", async () => { await held; return { generation }; });
	await coordinator.ensureLoaded();
	coordinator.notePaths("a", ["first.md"]);
	const first = coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	// The reserved job is visible before its asynchronous initial ledger write settles.
	await Promise.resolve();
	assert.equal(coordinator.jobs().length, 1);
	coordinator.notePaths("a", ["late.md"]);
	const late = coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	const [, receipt] = await Promise.all([first, late]);
	const id = String(receipt.refreshId);
	assert.ok(coordinator.get(id)?.paths?.includes("late.md"));
	const disk = JSON.parse(await readFile(join(root, "jobs.json"), "utf8"));
	assert.ok(disk.jobs.find((job: { refreshId: string }) => job.refreshId === id).paths.includes("late.md"));
	release();
	await coordinator.settled();
});

test("a rejected queued merge restores the accepted scope before execution", async (t) => {
	const { root, coordinator, releases } = await fixture(t);
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	releases.push(release);
	const executed: string[][] = [];
	coordinator.register("metadata", async (job) => {
		if (job.stores[0] === "a") { entered(); await held; }
		else executed.push([...(job.paths ?? [])]);
		return { generation };
	});
	coordinator.notePaths("a", ["hold.md"]);
	await coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	await started;
	coordinator.notePaths("b", ["accepted.md"]);
	const accepted = await coordinator.enqueue("metadata", ["b"], "explicit-maintenance");
	await chmod(root, 0o500);
	coordinator.notePaths("b", ["rejected.md"]);
	await assert.rejects(coordinator.enqueue("metadata", ["b"], "explicit-maintenance"), { code: "EACCES" });
	assert.deepEqual(coordinator.get(String(accepted.refreshId))?.paths, ["accepted.md"]);
	await chmod(root, 0o700);
	release();
	await coordinator.settled();
	assert.deepEqual(executed, [["accepted.md"]]);
});

test("qmd jobs cannot claim pending metadata paths", async (t) => {
	const { coordinator } = await fixture(t);
	coordinator.notePaths("a", ["metadata.md"]);
	const lexical = await coordinator.enqueue("lexical", ["a"], "explicit-maintenance");
	const semantic = await coordinator.enqueue("semantic", ["a"], "explicit-maintenance");
	assert.equal(lexical.paths, undefined);
	assert.equal(semantic.paths, undefined);
	const metadata = await coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	assert.deepEqual(metadata.paths, ["metadata.md"]);
});

test("a running scope admits a cancellable follow-up while newer notifications survive", async (t) => {
	const { coordinator, releases } = await fixture(t);
	let release!: () => void;
	let entered!: () => void;
	let released = false;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	releases.push(release);
	const executed: string[][] = [];
	coordinator.register("metadata", async (job) => {
		if (job.paths?.includes("hold.md")) { entered(); await held; }
		executed.push([...(job.paths ?? [])]);
		return { generation };
	});
	coordinator.notePaths("a", ["hold.md"]);
	const first = await coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	await started;
	coordinator.notePaths("a", ["cancelled.md"]);
	const cancelled = await coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	assert.equal(released, false);
	assert.notEqual(cancelled.refreshId, first.refreshId);
	await coordinator.cancel(String(cancelled.refreshId));
	coordinator.notePaths("a", ["newer.md"]);
	const newer = await coordinator.enqueue("metadata", ["a"], "explicit-maintenance");
	assert.notEqual(newer.refreshId, cancelled.refreshId);
	released = true;
	release();
	await coordinator.settled();
	assert.deepEqual(executed, [["hold.md"], ["newer.md"]]);
	assert.equal(coordinator.get(String(cancelled.refreshId))?.state, "cancelled");
});
