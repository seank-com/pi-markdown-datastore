import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";
import test from "node:test";
import { SharedIndexClient } from "../src/shared-client.ts";
import { attachSharedParser, encodeSharedMessage, listenOwnedSocket } from "../src/shared-ipc.ts";

async function fixture(t: import("node:test").TestContext, options: { holdHello?: boolean; invalid?: "generation" | "definition" } = {}) {
	const directory = await mkdtemp("/tmp/d4-client-");
	const path = join(directory, "s.sock"), generation = "gen-" + "e".repeat(32), definitionRevision = "f".repeat(64);
	const seen: string[] = [], sockets = new Set<Socket>();
	let helloSeen!: () => void, releaseHello!: () => void, peerClosed!: () => void;
	const hello = new Promise<void>(resolve => { helloSeen = resolve; });
	const held = new Promise<void>(resolve => { releaseHello = resolve; });
	const closed = new Promise<void>(resolve => { peerClosed = resolve; });
	if (!options.holdHello) releaseHello();
	const server = await listenOwnedSocket(path, socket => {
		sockets.add(socket); socket.once("close", () => { sockets.delete(socket); peerClosed(); });
		attachSharedParser(socket, (message: any) => {
			seen.push(message.operation);
			const send = (result: unknown, invalid = false) => { if (!socket.destroyed) socket.write(encodeSharedMessage({ version: 1, requestId: message.requestId, generation: invalid && options.invalid === "generation" ? "gen-" + "a".repeat(32) : generation, definitionRevision: invalid && options.invalid === "definition" ? "b".repeat(64) : definitionRevision, ok: true, result })); };
			if (message.operation === "hello") { helloSeen(); void held.then(() => send({ generation, version: "fixture" })); }
			if (message.operation === "activity") send({ state: "idle", active: false, queued: false, embeddingActive: false, jobs: [] }, true);
		}, () => socket.destroy());
	});
	const client = new SharedIndexClient({ socketPath: path, store: "notebook", definitionRevision });
	t.after(async () => { releaseHello(); await client.shutdown(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
	return { client, hello, releaseHello, closed, seen };
}

test("one cancelled attachment waiter does not cancel the other caller's handshake", async t => {
	const f = await fixture(t, { holdHello: true }), controller = new AbortController();
	const first = f.client.activity(controller.signal), cancelled = assert.rejects(first, { code: "CANCELLED" });
	await f.hello;
	const second = f.client.activity();
	controller.abort(); await cancelled;
	f.releaseHello();
	assert.equal((await second).state, "idle");
	assert.deepEqual(f.seen, ["hello", "activity"]);
});

test("shutdown cancels and closes a handshake that has not published its ready socket", async t => {
	const f = await fixture(t, { holdHello: true });
	const pending = f.client.activity(), cancelled = assert.rejects(pending, { code: "CANCELLED" });
	await f.hello; await f.client.shutdown(); await cancelled; await f.closed;
	f.releaseHello();
	await assert.rejects(f.client.activity(), { code: "CANCELLED" });
});

for (const invalid of ["generation", "definition"] as const) test(`a mismatched ${invalid} reply cannot satisfy an attached call`, async t => {
	const f = await fixture(t, { invalid });
	await assert.rejects(f.client.activity(), { code: "BACKEND_OUTPUT_INVALID" });
	await f.closed;
});
