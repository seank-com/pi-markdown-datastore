import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMarkdownDatastoreExtension } from "../src/index.ts";
import { createMarkdownDatastoreClient, queryMarkdownDatastoreCapability } from "../src/client.ts";
import { MARKDOWN_DATASTORE_REQUEST_EVENT } from "../src/contract.ts";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { MarkdownDatastoreService } from "../src/service.ts";

async function fixture(t: test.TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "datastore-policy-")));
  const project = join(base, "project"); const shared = join(base, "shared");
  const directory = join(project, ".pi/markdown-datastore"); const notes = join(project, "notes");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  await mkdir(notes); await mkdir(shared);
  await writeFile(join(notes, "one.md"), "# One\nBody\n", { mode: 0o640 });
  await writeFile(join(shared, "shared.md"), "# Shared\n");
  const store = (root: string, name: string) => ({ root, include: ["**/*.md"], exclude: ["one.md"], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: name } });
  const raw = { schemaVersion: 1, defaults: { maxResultBytes: 4096, maxResultLines: 100, operationTimeoutMs: 1000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notes: store("notes", "notes"), shared: store(shared, "shared") } };
  const configPath = join(directory, "config.json");
  const save = () => writeFile(configPath, JSON.stringify(raw), { mode: 0o600 }); await save();
  const emitter = new EventEmitter(); const handlers = new Map<string, Function>(); const entries: unknown[] = [];
  const events = { emit: (name: string, payload: unknown) => emitter.emit(name, payload), on(name: string, handler: (payload: unknown) => void) { emitter.on(name, handler); return () => { emitter.off(name, handler); }; } };
  let trusted = true;
  const ctx = { isProjectTrusted: () => trusted, ui: { setStatus() {} } };
  createMarkdownDatastoreExtension({ projectRoot: project })({ events, registerTool() {}, appendEntry(...args: unknown[]) { entries.push(args); }, on(name: string, handler: Function) { handlers.set(name, handler); } } as any);
  const fire = (name: string) => handlers.get(name)!({}, ctx);
  const client = () => createMarkdownDatastoreClient(events, { capability: queryMarkdownDatastoreCapability(events), timeoutMs: 1000 });
  t.after(async () => { await fire("session_shutdown"); await rm(base, { recursive: true, force: true }); });
  return { base, project, notes, shared, directory, configPath, raw, save, fire, client, events, entries, untrust() { trusted = false; } };
}
const code = (expected: string) => (error: any) => error.code === expected;

async function snapshot(path: string): Promise<unknown> {
  const info = await lstat(path);
  const metadata = { mode: info.mode, ino: info.ino, nlink: info.nlink, mtime: info.mtimeMs };
  if (!info.isDirectory()) return { ...metadata, bytes: await readFile(path, "hex") };
  const children: Record<string, unknown> = {};
  for (const name of (await readdir(path)).sort()) children[name] = await snapshot(join(path, name));
  return { ...metadata, children };
}

test("policy enumerates effective canonical roots and checks actual destinations without writes or qmd", async t => {
  const f = await fixture(t); const before = await snapshot(f.base);
  await f.fire("session_start"); const client = f.client();
  const roots = (await client.roots({})).data.roots;
  assert.deepEqual(roots.map(root => [root.store, root.path]), [["notes", f.notes], ["shared", f.shared]]);
  for (const root of roots) { const info = await lstat(root.path); assert.equal(root.device, info.dev); assert.equal(root.inode, info.ino); }
  for (const path of [f.notes, join(f.notes, "one.md"), join(f.notes, "new/sub/file.bin"), f.shared, join(f.shared, "new.md")]) {
    const result = (await client.validateDestination({ path })).data;
    assert.equal(result.owned, true); assert.ok(result.stores.length > 0);
  }
  for (const path of [join(f.project, "beside.md"), join(f.project, "notes-other/new.md"), join(f.base, "outside.md"), f.project]) {
    assert.deepEqual((await client.validateDestination({ path })).data, { path, owned: false, stores: [] });
  }
  assert.deepEqual(f.entries, [], "policy operations do not append session/journal entries");
  assert.deepEqual(await snapshot(f.base), before, "source, permissions, directories and derived state stay untouched");
  // Selection globs do not restrict direct identity or policy containment.
  assert.match(String((await client.read({ note: { store: "notes", path: "one.md" } })).data.content), /Body/);
  assert.equal((await client.find({ store: "notes", selectors: [{ kind: "path", path: "one.md" }] })).data.candidates.length, 1);
  await assert.rejects(client.search({ store: "notes", query: "body" }), code("CAPABILITY_UNAVAILABLE"));
  await assert.rejects(createMarkdownDatastoreClient(f.events).roots({}), code("CAPABILITY_UNAVAILABLE"));
});

test("policy rejects symlink ancestry, hard links, traversal and unsafe file types", async t => {
  const f = await fixture(t); await f.fire("session_start"); const client = f.client();
  await symlink(f.notes, join(f.project, "alias"));
  await symlink(join(f.notes, "one.md"), join(f.project, "alias.md"));
  await symlink(join(f.base, "missing"), join(f.project, "dangling"));
  await link(join(f.notes, "one.md"), join(f.project, "hard.md"));
  for (const path of [join(f.project, "alias/new.md"), join(f.project, "alias.md"), join(f.project, "dangling/new.md")]) await assert.rejects(client.validateDestination({ path }), code("SYMLINK_REJECTED"));
  for (const path of [join(f.project, "hard.md"), join(f.notes, "one.md/child")]) await assert.rejects(client.validateDestination({ path }), code("UNSAFE_FILE_TYPE"));
  for (const path of ["relative.md", `${f.notes}/../outside.md`, `${f.notes}/./one.md`, `${f.notes}/bad\u0000.md`]) await assert.rejects(client.validateDestination({ path }), code("INVALID_NOTE_REF"));
  const capability = queryMarkdownDatastoreCapability(f.events)!;
  const call = (request: unknown, deadline = Date.now() + 1000) => new Promise((resolve, reject) => f.events.emit(MARKDOWN_DATASTORE_REQUEST_EVENT, { contractVersion: 1, requestId: "invalid-policy", instanceId: capability.instanceId, request, deadline, resolve, reject }));
  await assert.rejects(call({ operation: "roots", input: { extra: true } }), code("CONFIG_INVALID"));
  await assert.rejects(call({ operation: "roots", input: {} }, Date.now() - 1), code("TIMEOUT"));
  assert.deepEqual(f.entries, []);
});

test("configured root aliases are refused without rewriting source or symlinks", async t => {
  const f = await fixture(t);
  await symlink(f.notes, join(f.project, "alias"));
  for (const root of ["alias", "alias/child"]) {
    if (root.includes("/")) await mkdir(join(f.notes, "child"));
    f.raw.stores.notes.root = root; await f.save();
    await assert.rejects(loadMarkdownDatastoreConfig(f.project), code("SYMLINK_REJECTED"));
    await f.fire("session_start"); await assert.rejects(f.client().roots({}), code("SYMLINK_REJECTED"));
    assert.equal((await lstat(join(f.project, "alias"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(f.notes, "one.md"), "utf8"), "# One\nBody\n");
  }
});

test("a new ancestor alias cannot preserve access merely by preserving the root inode", async t => {
  const f = await fixture(t); await f.fire("session_start"); const client = f.client();
  await rename(f.project, `${f.project}-moved`); await symlink(`${f.project}-moved`, f.project);
  await assert.rejects(client.roots({}), code("STORE_UNAVAILABLE"));
  await assert.rejects(client.validateDestination({ path: join(f.base, "outside.md") }), code("STORE_UNAVAILABLE"));
  await assert.rejects(client.read({ note: { store: "notes", path: "one.md" } }), code("STORE_UNAVAILABLE"));
  await assert.rejects(client.refresh({ mode: "direct" }), code("STORE_UNAVAILABLE"));
});

test("missing, invalid and untrusted instances return explicit policy errors", async t => {
  const f = await fixture(t);
  await rm(f.configPath); await f.fire("session_start");
  await assert.rejects(f.client().roots({}), code("CONFIG_MISSING"));
  await assert.rejects(f.client().validateDestination({ path: join(f.project, "new.md") }), code("CONFIG_MISSING"));
  await writeFile(f.configPath, '{"schemaVersion":1}', { mode: 0o600 }); await f.fire("session_start");
  await assert.rejects(f.client().roots({}), code("CONFIG_INVALID"));
  await f.save(); f.untrust(); await f.fire("session_start");
  await assert.rejects(f.client().roots({}), code("PROJECT_UNTRUSTED"));
  assert.deepEqual(f.entries, []);
});

test("root replacement, ancestry aliases, shutdown and stale discovered references fail closed", async t => {
  const f = await fixture(t); await f.fire("session_start");
  const client = f.client(); const capability = queryMarkdownDatastoreCapability(f.events)!; const instanceId = capability.instanceId;
  await rename(f.notes, `${f.notes}-old`); await mkdir(f.notes);
  await assert.rejects(client.roots({}), code("STORE_UNAVAILABLE"));
  await assert.rejects(client.validateDestination({ path: join(f.project, "outside.md") }), code("STORE_UNAVAILABLE"));
  await rm(f.notes, { recursive: true }); await symlink(`${f.notes}-old`, f.notes);
  await assert.rejects(client.roots({}), code("STORE_UNAVAILABLE"));
  await rm(f.notes); await rename(`${f.notes}-old`, f.notes);
  await f.fire("session_start");
  assert.equal(capability.ready, false); assert.equal(capability.instanceId, undefined);
  await assert.rejects(client.roots({}), code("CAPABILITY_UNAVAILABLE"));
  // A retained copied ID cannot accidentally dispatch against a replacement service.
  await assert.rejects(new Promise((resolve, reject) => f.events.emit(MARKDOWN_DATASTORE_REQUEST_EVENT, { contractVersion: 1, requestId: "stale", instanceId, request: { operation: "roots", input: {} }, deadline: Date.now() + 1000, resolve, reject })), code("STORE_UNAVAILABLE"));
  const fresh = f.client(); assert.equal((await fresh.roots({})).data.roots.length, 2);
  await f.fire("session_shutdown"); await assert.rejects(fresh.roots({}), code("CAPABILITY_UNAVAILABLE"));
  const config = await loadMarkdownDatastoreConfig(f.project); const service = new MarkdownDatastoreService(config); await service.shutdown();
  await assert.rejects(service.roots({}), code("CANCELLED"));
  assert.deepEqual(f.entries, []);
});
