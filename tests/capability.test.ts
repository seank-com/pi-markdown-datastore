import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMarkdownDatastoreExtension } from "../src/index.ts";
import { createMarkdownDatastoreClient, queryMarkdownDatastoreCapability } from "../src/client.ts";
import { MARKDOWN_DATASTORE_CAPABILITY_REQUEST, MARKDOWN_DATASTORE_CAPABILITY_REPLY, MARKDOWN_DATASTORE_REQUEST_EVENT } from "../src/contract.ts";

async function fixture(t: test.TestContext, trusted = true) {
  const project = await mkdtemp(join(tmpdir(), "datastore-capability-"));
  const emitter = new EventEmitter();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const events = {
    emit(channel: string, data: unknown) { emitter.emit(channel, data); },
    on(channel: string, handler: (data: unknown) => void) { emitter.on(channel, handler); return () => { emitter.off(channel, handler); }; },
  };
  const ctx = { isProjectTrusted: () => trusted, ui: { setStatus() {} } };
  const fire = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  t.after(async () => { await fire("session_shutdown"); await rm(project, { recursive: true, force: true }); });
  const dir = join(project, ".pi/markdown-datastore");
  await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
  await mkdir(join(project, "notes"));
  await writeFile(join(project, "notes/one.md"), "# One\nFixture source\n");
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1,
    defaults: { maxResultBytes: 4096, maxResultLines: 100, operationTimeoutMs: 1000 },
    qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" },
    stores: { notes: { root: "notes", include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } } },
  }), { mode: 0o600 });
  const pi: any = { events, on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool() {}, appendEntry() {} };
  const initialize = (path = configPath) => createMarkdownDatastoreExtension({ projectRoot: project, configPath: path })(pi);
  return { project, configPath, events, emitter, initialize, fire };
}

test("absent discovery is synchronous, bounded, and leaves no reply subscription", async t => {
  const f = await fixture(t);
  assert.equal(queryMarkdownDatastoreCapability(f.events), undefined);
  assert.equal(f.emitter.listenerCount(MARKDOWN_DATASTORE_CAPABILITY_REPLY), 0);
});
test("discovery reports only configured stores; teardown revokes retained capabilities", async t => {
  const f = await fixture(t); f.initialize();
  const before = queryMarkdownDatastoreCapability(f.events)!;
  assert.equal(before.ready, false); assert.deepEqual(before.stores, []);
  await f.fire("session_start");
  const capability = queryMarkdownDatastoreCapability(f.events)!;
  assert.equal(capability.version, 1); assert.equal(capability.contractVersion, 1);
  assert.equal(capability.ready, true); assert.deepEqual(capability.stores, ["notes"]);
  assert.equal(before.ready, false);
  const client = createMarkdownDatastoreClient(f.events, { timeoutMs: 1000 });
  assert.match(String((await client.read({ note: { store: "notes", path: "one.md" } })).data.content), /Fixture source/);
  await assert.rejects(client.read({ note: { store: "unconfigured", path: "one.md" } }), (error: any) => error.code === "STORE_UNKNOWN");
  await assert.rejects(client.search({ store: "notes", query: "fixture" }), (error: any) => error.code === "CAPABILITY_UNAVAILABLE");
  await f.fire("session_shutdown");
  assert.equal(capability.ready, false); assert.deepEqual(capability.stores, []);
  assert.equal(queryMarkdownDatastoreCapability(f.events), undefined);
  assert.equal(f.emitter.listenerCount(MARKDOWN_DATASTORE_REQUEST_EVENT), 0);
  assert.equal(f.emitter.listenerCount(MARKDOWN_DATASTORE_CAPABILITY_REQUEST), 0);
  await f.fire("session_start");
  assert.equal(queryMarkdownDatastoreCapability(f.events)?.ready, true);
  assert.equal(capability.ready, false);
  assert.equal(f.emitter.listenerCount(MARKDOWN_DATASTORE_CAPABILITY_REQUEST), 1);
});
test("missing configuration and untrusted projects report no ready stores", async t => {
  const missing = await fixture(t); missing.initialize(join(missing.project, ".pi/markdown-datastore/absent.json")); await missing.fire("session_start");
  const untrusted = await fixture(t, false); untrusted.initialize(); await untrusted.fire("session_start");
  for (const f of [missing, untrusted]) { const cap = queryMarkdownDatastoreCapability(f.events)!; assert.equal(cap.ready, false); assert.deepEqual(cap.stores, []); }
});
test("discovery rejects incompatible/malformed replies and duplicate active responders", async t => {
  const absent = await fixture(t);
  absent.events.on(MARKDOWN_DATASTORE_CAPABILITY_REQUEST, (data: any) => {
    for (const capability of [{version:2,contractVersion:1,ready:true,stores:["notes"]}, {version:1,contractVersion:1,ready:true,stores:["../other"]}, {version:1,contractVersion:1,ready:true,stores:["notes","notes"]}]) {
      absent.events.emit(MARKDOWN_DATASTORE_CAPABILITY_REPLY, {version:1,requestId:data.requestId,capability});
    }
  });
  assert.equal(queryMarkdownDatastoreCapability(absent.events), undefined);
  const f = await fixture(t); f.initialize(); f.initialize(); await f.fire("session_start");
  assert.equal(queryMarkdownDatastoreCapability(f.events), undefined);
});
test("shutdown during async initialization cannot publish a later ready capability", async t => {
  const f = await fixture(t);
  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(f.configPath, "utf8")); raw.qmd.enabled = true;
  await writeFile(f.configPath, JSON.stringify(raw), { mode: 0o600 });
  let started!: () => void; let release!: () => void; let closed = false;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const backend = new Promise<any>(resolve => { release = () => resolve({ shutdown: async () => { closed = true; } }); });
  const handlers = new Map<string, Function>();
  createMarkdownDatastoreExtension({ projectRoot: f.project, createQmd: async () => { started(); return backend; } })({ events: f.events, on(name: string, handler: Function) { handlers.set(name, handler); }, registerTool() {}, appendEntry() {} } as any);
  const ctx = { isProjectTrusted: () => true, ui: { setStatus() {} } };
  const pending = handlers.get("session_start")!({}, ctx);
  await entered;
  await handlers.get("session_shutdown")!({}, ctx);
  release(); await pending;
  assert.equal(closed, true);
  assert.equal(queryMarkdownDatastoreCapability(f.events), undefined);
});
