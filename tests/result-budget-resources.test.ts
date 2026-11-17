import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DEFAULT_MARKDOWN_DATASTORE_CLIENT_TIMEOUT_MS } from "../src/client.ts";
import { QmdWorkerClient } from "../src/qmd-worker-client.ts";
import { attachSharedParser, encodeSharedMessage, sharedError } from "../src/shared-ipc.ts";

// Probe sizes cross historical transport boundaries; they are not production limits.
const payload = String.fromCodePoint(0x3c0).repeat(600000);
test("valid request/result frames exceed 1MiB and release parser ownership after each result", async t => {
 const root = await mkdtemp("/tmp/budget-large-worker-");
 const sdk = join(root, "sdk.mjs");
 await writeFile(sdk, `export async function createStore({config}) { return { getStatus:async()=>({totalDocuments:0,needsEmbedding:0,hasVectorIndex:false}), getIndexHealth:async()=>({diagnostic:config.probe}), listCollections:async()=>[], close:async()=>{} }; }`);
 const worker = new QmdWorkerClient(DEFAULT_MARKDOWN_DATASTORE_CLIENT_TIMEOUT_MS);
 t.after(async () => { await worker.shutdown(); await rm(root, { recursive: true, force: true }); });
 const request = { version: 2 as const, sdkUrl: pathToFileURL(sdk).href, dbPath: join(root, "index.sqlite"), config: { collections: {}, probe: payload }, operation: "status" };
 assert(Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024);
 for (let index = 0; index < 2; index++) {
  const result = await worker.request(request);
  assert.equal(result.health.diagnostic, payload);
  assert.equal(worker.bufferedBytes, 0);
  assert.equal(worker.busy, false);
 }
 await worker.shutdown(); assert.equal(worker.bufferedBytes, 0); assert.equal(worker.processId, undefined);
});

test("shared parser decodes split UTF8/multiple large frames and detaches partial state on close or invalid JSON", async () => {
 const stream = new PassThrough(), values: unknown[] = [], errors: unknown[] = [];
 attachSharedParser(stream as unknown as Socket, message => values.push(message), error => errors.push(error));
 const wire = Buffer.from(encodeSharedMessage({ value: payload }));
 const split = wire.indexOf(Buffer.from(String.fromCodePoint(0x3c0))) + 1;
 stream.write(wire.subarray(0, split)); stream.write(wire.subarray(split));
 stream.write(encodeSharedMessage({ second: true }));
 assert.deepEqual(values, [{ value: payload }, { second: true }]); assert.deepEqual(errors, []);
 stream.write('{"partial":"' + payload);
 const closed = once(stream, "close"); stream.destroy(); await closed;
 assert.equal(stream.listenerCount("data"), 0); assert.equal(stream.listenerCount("close"), 0);
 const malformed = new PassThrough();
 attachSharedParser(malformed as unknown as Socket, () => assert.fail("invalid JSON was admitted"), error => errors.push(error));
 malformed.write("not-json\n");
 assert.equal(errors.length, 1); assert.equal(malformed.listenerCount("data"), 0); assert.equal(malformed.listenerCount("close"), 0);
 malformed.destroy();
});

for (const outcome of ["cancel", "failure"]) test(`partial worker frames are released on ${outcome}`, async t => {
 const root = await mkdtemp("/tmp/budget-partial-worker-"), sdk = join(root, "sdk.mjs");
 await writeFile(sdk, `export async function createStore() { return { getStatus:async()=>({totalDocuments:0,needsEmbedding:0,hasVectorIndex:false}), getIndexHealth:async()=>{process.stdout.write('{"partial":"'+'x'.repeat(1200000),()=>{${outcome === "failure" ? "process.exit(1)" : ""}});return new Promise(()=>{});}, close:async()=>{} }; }`);
 const worker = new QmdWorkerClient(DEFAULT_MARKDOWN_DATASTORE_CLIENT_TIMEOUT_MS), controller = new AbortController();
 t.after(async () => { await worker.shutdown(); await rm(root, { recursive: true, force: true }); });
 const pending = worker.request({ version: 2, sdkUrl: pathToFileURL(sdk).href, dbPath: join(root, "index.sqlite"), config: { collections: {} }, operation: "status" }, { signal: controller.signal });
 const rejected = assert.rejects(pending, { code: outcome === "cancel" ? "CANCELLED" : "BACKEND_FAILED" });
 if (outcome === "cancel") { while (worker.bufferedBytes === 0) await new Promise(resolve => setImmediate(resolve)); controller.abort(); }
 await rejected; assert.equal(worker.bufferedBytes, 0); assert.equal(worker.processId, undefined); assert.equal(worker.busy, false);
});

test("shared errors preserve applied-work IDs and model-readable outcome", () => {
 const refreshIds = ["ab".repeat(16), "cd".repeat(16)];
 const error = sharedError(JSON.parse(JSON.stringify({ code: "RESULT_LIMIT_EXCEEDED", details: { operationApplied: true, refreshIds } })));
 assert.equal(error.details?.operationApplied, true);
 assert.deepEqual(error.details?.refreshIds, refreshIds);
 for (const id of refreshIds) assert(error.message.includes(id));
});
