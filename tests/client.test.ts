import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
	createMarkdownDatastoreClient,
	MarkdownDatastoreClientError,
} from "../src/client.ts";
import {
	MARKDOWN_DATASTORE_REQUEST_EVENT,
	type MarkdownDatastoreRpcEnvelope,
	type SearchResult,
} from "../src/contract.ts";

function result(operation: "search" = "search"): SearchResult {
	return {
		contractVersion: 1,
		operation,
		store: "telegram",
		data: { hits: [], examined: 0, dropped: 0, returned: 0 },
		provenance: { sources: [], startedAt: "2026-09-24T00:00:00Z", completedAt: "2026-09-24T00:00:00Z", durationMs: 0 },
		bounds: { maxBytes: 4096, maxLines: 100, returnedBytes: 0, returnedLines: 0, truncated: false },
		warnings: [],
	};
}

function bus(emitter: EventEmitter) {
	return { emit: (event: string, payload: unknown) => emitter.emit(event, payload) };
}

test("typed client translates search into one versioned event RPC envelope", async () => {
	const emitter = new EventEmitter();
	let observed: MarkdownDatastoreRpcEnvelope | undefined;
	emitter.on("pi-markdown-datastore:v1:request", (payload) => {
		observed = payload;
		payload.resolve(result());
	});
	const client = createMarkdownDatastoreClient(bus(emitter), {
		timeoutMs: 1_000,
		createRequestId: () => "client-request",
		now: () => 10_000,
	});
	const signal = new AbortController().signal;
	const received = await client.search({ store: "telegram", query: "earlier decision", mode: "hybrid" }, signal);
	assert.equal(received.operation, "search");
	assert.equal(observed?.contractVersion, 1);
	assert.equal(observed?.requestId, "client-request");
	assert.equal(observed?.deadline, 11_000);
	assert.equal(observed?.signal?.aborted, false);
	assert.deepEqual(observed?.request, { operation: "search", input: { store: "telegram", query: "earlier decision", mode: "hybrid" } });
});

test("typed client bounds missing responders and reacts promptly to cancellation", async () => {
	const emitter = new EventEmitter();
	const timeoutClient = createMarkdownDatastoreClient(bus(emitter), { timeoutMs: 10 });
	await assert.rejects(timeoutClient.status({}), (error: unknown) => error instanceof MarkdownDatastoreClientError && error.code === "TIMEOUT");

	const cancelClient = createMarkdownDatastoreClient(bus(emitter), { timeoutMs: 1_000 });
	const controller = new AbortController();
	const pending = cancelClient.status({}, controller.signal);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof MarkdownDatastoreClientError && error.code === "CANCELLED");
	await assert.rejects(cancelClient.status({}, controller.signal), (error: unknown) => error instanceof MarkdownDatastoreClientError && error.code === "CANCELLED");
});

test("typed client rejects malformed and wrong-operation responses", async () => {
	for (const bad of [{}, { ...result(), operation: "read" }]) {
		const emitter = new EventEmitter();
		emitter.on(MARKDOWN_DATASTORE_REQUEST_EVENT, (payload) => payload.resolve(bad));
		const client = createMarkdownDatastoreClient(bus(emitter), { timeoutMs: 100 });
		await assert.rejects(client.search({ store: "telegram", query: "x" }), (error: unknown) => error instanceof MarkdownDatastoreClientError && error.code === "BACKEND_OUTPUT_INVALID");
	}
});

test("typed client preserves service rejections and settles only once", async () => {
	const expected = Object.assign(new Error("STORE_UNKNOWN"), { code: "STORE_UNKNOWN" });
	const rejectEmitter = new EventEmitter();
	rejectEmitter.on(MARKDOWN_DATASTORE_REQUEST_EVENT, (payload) => payload.reject(expected));
	const rejecting = createMarkdownDatastoreClient(bus(rejectEmitter), { timeoutMs: 100 });
	await assert.rejects(rejecting.status({ store: "missing" }), (error: unknown) => error === expected);

	const duplicateEmitter = new EventEmitter();
	duplicateEmitter.on(MARKDOWN_DATASTORE_REQUEST_EVENT, (payload) => {
		payload.resolve(result());
		payload.reject(new Error("late rejection"));
	});
	const duplicate = createMarkdownDatastoreClient(bus(duplicateEmitter), { timeoutMs: 100 });
	assert.equal((await duplicate.search({ store: "telegram", query: "x" })).operation, "search");
});

test("typed client rejects invalid timeout configuration", () => {
	assert.throws(() => createMarkdownDatastoreClient({ emit() {} }, { timeoutMs: 0 }), RangeError);
	assert.throws(() => createMarkdownDatastoreClient({ emit() {} }, { timeoutMs: 900_001 }), RangeError);
});

test("default RPC budget permits a 19-second query and aborts work at its deadline", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const emitter = new EventEmitter();
	let envelope: MarkdownDatastoreRpcEnvelope;
	emitter.on(MARKDOWN_DATASTORE_REQUEST_EVENT, (payload) => { envelope = payload; });
	const client = createMarkdownDatastoreClient(bus(emitter));
	const slow = client.search({ store: "telegram", query: "earlier decision", mode: "hybrid" });
	t.mock.timers.tick(19_000);
	envelope!.resolve(result());
	assert.equal((await slow).operation, "search");
	const expired = client.search({ store: "telegram", query: "hung query", mode: "hybrid" });
	const rejected = assert.rejects(expired, (error: any) => error.code === "TIMEOUT");
	t.mock.timers.tick(900_000);
	await rejected;
	assert.equal(envelope!.signal?.aborted, true, "timeout must reach the backend, not only reject the caller");
	assert.equal((envelope!.signal!.reason as any).code, "TIMEOUT");
});
