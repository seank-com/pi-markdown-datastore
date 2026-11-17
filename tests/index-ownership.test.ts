import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireIndexOwnership } from "../src/index-ownership.ts";

function message(child: ChildProcess, state: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const clear = () => { child.off("message", receive); child.off("error", fail); child.off("exit", exited); };
		const receive = (value: any) => { if (value?.state === state || value?.state === "refused") { clear(); resolve(value); } };
		const fail = (error: Error) => { clear(); reject(error); };
		const exited = () => fail(new Error("Fixture owner exited before replying"));
		child.on("message", receive); child.once("error", fail); child.once("exit", exited);
	});
}
function owner(root: string) {
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/index-owner.ts", import.meta.url)), root], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const armed = message(child, "armed");
	return { child, exited, armed, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; } };
}

test("index ownership refuses a second adapter and releases without a stale file", async () => {
	const root = await mkdtemp(join(tmpdir(), "index-owner-"));
	const first = await acquireIndexOwnership(root);
	try { await assert.rejects(acquireIndexOwnership(root), { code: "STORE_UNAVAILABLE" }); }
	finally { await first.release(); }
	const next = await acquireIndexOwnership(root);
	assert.notEqual(next.nonce, first.nonce);
	await next.release();
	assert.deepEqual(await readdir(root), []);
	await rm(root, { recursive: true });
});

test("crashed owners are reclaimed automatically but live workers still exclude a successor", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "index-crash-"));
	const holder = owner(root), worker = owner(root);
	let successor: Awaited<ReturnType<typeof acquireIndexOwnership>> | undefined;
	t.after(async () => { await holder.stop(); await worker.stop(); await successor?.release(); await rm(root, { recursive: true, force: true }); });
	await Promise.all([holder.armed, worker.armed]);
	const acquired = message(holder.child, "owned"); holder.child.send({ action: "acquire" });
	const record = await acquired; assert.equal(record.state, "owned");
	// Application-owned worker registration, not dependency storage.
	await writeFile(join(record.directory, `worker-${worker.child.pid}-${record.nonce}`), "", { mode: 0o600 });
	await holder.stop();
	await assert.rejects(acquireIndexOwnership(root), { code: "STORE_UNAVAILABLE" });
	await worker.stop();
	successor = await acquireIndexOwnership(root);
	assert.notEqual(successor.nonce, record.nonce);
	assert.deepEqual(await readdir(successor.directory), [successor.ownerName]);
});

test("concurrent recovery publishes only one nonempty ownership generation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "index-race-"));
	const stale = owner(root), left = owner(root), right = owner(root);
	t.after(async () => { await Promise.all([stale.stop(), left.stop(), right.stop()]); await rm(root, { recursive: true, force: true }); });
	await Promise.all([stale.armed, left.armed, right.armed]);
	const old = message(stale.child, "owned"); stale.child.send({ action: "acquire" });
	assert.equal((await old).state, "owned"); await stale.stop();
	const a = message(left.child, "owned"), b = message(right.child, "owned");
	left.child.send({ action: "acquire" }); right.child.send({ action: "acquire" });
	const outcomes = await Promise.all([a, b]);
	assert.deepEqual(outcomes.map(item => item.state).sort(), ["owned", "refused"]);
	assert.equal(outcomes.find(item => item.state === "refused").code, "STORE_UNAVAILABLE");
	assert.equal((await readdir(join(root, "owner"))).length, 1);
});

test("unknown ownership metadata is not treated as a dead owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "index-invalid-"));
	try {
		await mkdir(join(root, "owner"), { mode: 0o700 });
		await writeFile(join(root, "owner", "unrecognized"), "", { mode: 0o600 });
		await assert.rejects(acquireIndexOwnership(root), { code: "INDEX_CORRUPT" });
		assert.deepEqual(await readdir(join(root, "owner")), ["unrecognized"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});
