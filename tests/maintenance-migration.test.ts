import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectTerminalHistory, initializeTerminalHistory } from "../src/maintenance-migration.ts";
import { adoptLegacyApplicationJobs, MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { acquireIndexOwnership } from "../src/index-ownership.ts";
import { EventEmitter } from "node:events";
import { createMarkdownDatastoreExtension } from "../src/index.ts";
import { createMarkdownDatastoreClient, queryMarkdownDatastoreCapability } from "../src/client.ts";
import { startSharedHost } from "../src/shared-host.ts";

type Context = import("node:test").TestContext;
async function fixture(t: Context) {
 const root = await realpath(await mkdtemp(join(tmpdir(), "maintenance-migration-")));
 t.after(() => rm(root, { recursive: true, force: true }));
 return root;
}
function job(n: number, state = "succeeded") {
 return { version: 1, refreshId: n.toString(16).padStart(32, "0"), key: "lexical:retired-group", mode: "lexical", stores: ["retired-group"], ownership: "explicit-maintenance", state, phase: state === "running" ? "updating" : state, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", progress: { documentsCompleted: 1, errors: 0 } };
}
async function legacy(root: string, n: number, jobs: unknown[] = [job(n)]) {
 const directory = join(root, `qmd-public-2.8.3-${n.toString(16).padStart(16, "0")}`);
 await mkdir(directory, { mode: 0o700 });
 const path = join(directory, "jobs.json");
 await writeFile(path, JSON.stringify({ version: 1, jobs }), { mode: 0o600 });
 return { directory, path };
}
async function missing(path: string) { await assert.rejects(lstat(path), { code: "ENOENT" }); }

test("explicit initialization preserves all 108 receipts across seven unrelated historical namespaces", async t => {
 const root = await fixture(t), sources = new Map<string, Buffer>();
 for (const [i, count] of [20, 6, 20, 20, 2, 20, 20].entries()) {
  const source = await legacy(root, i + 1, Array.from({ length: count }, (_, j) => job(i * 100 + j + 1, j % 3 === 0 ? "failed" : j % 3 === 1 ? "cancelled" : "succeeded")));
  sources.set(source.path, await readFile(source.path));
  await mkdir(join(source.directory, "backend"), { mode: 0o700 });
  await writeFile(join(source.directory, "backend", "opaque-sentinel"), "not an application ledger");
 }
 const beforeNames = await readdir(root);
 const plan = await inspectTerminalHistory(root);
 assert.equal(plan.histories.length, 7); assert.equal(plan.jobs, 108); assert.equal(plan.unfinishedJobs, 0); assert.equal(plan.eligible, true);
 await missing(join(root, "jobs.json")); assert.deepEqual(await readdir(root), beforeNames);
 await assert.rejects(adoptLegacyApplicationJobs(root, join(root, "jobs.json"), new Set(["current"]), () => join(root, "qmd-public-2.8.3-ffffffffffffffff")), { code: "INDEX_CORRUPT" });
 const result = await initializeTerminalHistory(root);
 assert.equal(result.initialized, true); assert.equal(result.jobs, 108);
 assert.deepEqual(JSON.parse(await readFile(join(root, "jobs.json"), "utf8")), { version: 1, jobs: [] });
 assert.equal((await lstat(join(root, "jobs.json"))).mode & 0o777, 0o600);
 for (const [path, bytes] of sources) assert.deepEqual(await readFile(path), bytes);
 for (const source of result.histories) assert.equal(await readFile(join(source.path, "..", "backend", "opaque-sentinel"), "utf8"), "not an application ledger");
 const coordinator = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["current-private", "current-shared"]));
 await coordinator.ensureLoaded(); assert.deepEqual(coordinator.jobs(), []); coordinator.shutdown();
 await missing(join(root, "owner"));
});

for (const state of ["queued", "running"]) test(`${state} history is not abandoned or requeued in place`, async t => {
 const root = await fixture(t), source = await legacy(root, 1, [job(1, state)]), bytes = await readFile(source.path);
 const plan = await inspectTerminalHistory(root); assert.equal(plan.unfinishedJobs, 1); assert.equal(plan.eligible, false);
 await assert.rejects(initializeTerminalHistory(root), { code: "STORE_UNAVAILABLE" });
 assert.deepEqual(await readFile(source.path), bytes); await missing(join(root, "jobs.json"));
});

for (const scope of ["application", "historical"]) test(`a live ${scope} owner prevents initialization`, async t => {
 const root = await fixture(t), source = await legacy(root, 1);
 const lease = await acquireIndexOwnership(scope === "application" ? root : source.directory);
 try {
  const plan = await inspectTerminalHistory(root); assert.equal(plan.eligible, false);
  await assert.rejects(initializeTerminalHistory(root), { code: "STORE_UNAVAILABLE" }); await missing(join(root, "jobs.json"));
 } finally { await lease.release(); }
});

test("uncertain ownership is not treated as dead", async t => {
 const root = await fixture(t), source = await legacy(root, 1);
 await mkdir(join(source.directory, "owner"), { mode: 0o700 });
 await writeFile(join(source.directory, "owner", "unrecognized"), "", { mode: 0o600 });
 const plan = await inspectTerminalHistory(root); assert.equal(plan.histories[0].owner, "uncertain"); assert.equal(plan.eligible, false);
 await assert.rejects(initializeTerminalHistory(root), { code: "STORE_UNAVAILABLE" }); await missing(join(root, "jobs.json"));
});

test("existing stable state is never replaced, including a later explicit invocation", async t => {
 const root = await fixture(t); await legacy(root, 1); await initializeTerminalHistory(root);
 const bytes = JSON.stringify({ version: 1, jobs: [job(9, "queued")] });
 await writeFile(join(root, "jobs.json"), bytes, { mode: 0o600 });
 const result = await initializeTerminalHistory(root); assert.equal(result.initialized, false); assert.equal(result.stableLedgerExists, true);
 assert.equal(await readFile(join(root, "jobs.json"), "utf8"), bytes);
});

for (const problem of ["json", "schema", "mode", "symlink", "hardlink"]) test(`invalid ${problem} application history is preserved and refused`, async t => {
 const root = await fixture(t), source = await legacy(root, 1);
 if (problem === "json") await writeFile(source.path, "not JSON");
 if (problem === "schema") await writeFile(source.path, JSON.stringify({ version: 1, jobs: [{ ...job(1), unknown: true }] }));
 if (problem === "mode") await chmod(source.path, 0o644);
 if (problem === "symlink") { await rm(source.path); await writeFile(join(root, "other.json"), JSON.stringify({ version: 1, jobs: [] }), { mode: 0o600 }); await symlink(join(root, "other.json"), source.path); }
 if (problem === "hardlink") await link(source.path, join(root, "other.json"));
 await assert.rejects(initializeTerminalHistory(root), { code: "INDEX_CORRUPT" }); await missing(join(root, "jobs.json"));
});

test("canonical protected application directory is required", async t => {
 const root = await fixture(t); await legacy(root, 1);
 await assert.rejects(inspectTerminalHistory("relative-state"), { code: "CONFIG_INVALID" });
 const alias = root + "-alias"; await symlink(root, alias); t.after(() => rm(alias));
 await assert.rejects(inspectTerminalHistory(alias), { code: "CONFIG_INVALID" });
 await chmod(root, 0o755); await assert.rejects(inspectTerminalHistory(root), { code: "INDEX_CORRUPT" });
});

test("unchanged extension startup recovers private and shared operations after explicit initialization", async t => {
 const root = await fixture(t), project = join(root, "project"), configDir = join(project, ".pi/markdown-datastore"), state = join(configDir, "state");
 const privateNotes = join(root, "private"), groupNotes = join(root, "group");
 await mkdir(state, { recursive: true, mode: 0o700 }); await mkdir(privateNotes); await mkdir(groupNotes);
 await writeFile(join(privateNotes, "one.md"), "Private fixture text.\n");
 await writeFile(join(groupNotes, "group.md"), "---\ntags: [shared]\n---\nGroup fixture.\n");
 const defaults = { operationTimeoutMs: 30000 }, qmd = { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" };
 const definition = (path: string, collection: string) => ({ root: path, include: ["**/*.md"], exclude: [], maxFileBytes: 200000, search: { defaultMode: "lexical", qmdCollection: collection } });
 const catalog = join(root, "catalog.json");
 await writeFile(catalog, JSON.stringify({ schemaVersion: 1, defaults, qmd, socketPath: join(root, "shared.sock"), stateRoot: join(root, "shared-state"), stores: { sisterhood: definition(groupNotes, "group") } }), { mode: 0o600 });
 const host = await startSharedHost(catalog); t.after(() => host.close());
 await host.coordinators.get("sisterhood")!.enqueue("metadata", ["sisterhood"], "explicit-maintenance"); await host.coordinators.get("sisterhood")!.settled();
 await writeFile(join(configDir, "config.json"), JSON.stringify({ schemaVersion: 1, defaults, qmd, stores: { telegram: definition(privateNotes, "private"), "telegram-group": { shared: { catalog, store: "sisterhood" } } } }), { mode: 0o600 });
 for (let n = 1; n <= 7; n += 1) await legacy(state, n);
 const emitter = new EventEmitter(), handlers = new Map<string, Function[]>();
 const api: any = { events: { emit: (name: string, payload: unknown) => emitter.emit(name, payload), on: (name: string, fn: any) => { emitter.on(name, fn); return () => emitter.off(name, fn); } }, on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerTool() {}, appendEntry() {} };
 const fire = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, { cwd: project, isProjectTrusted: () => true, ui: { setStatus() {} } }); };
 createMarkdownDatastoreExtension({ projectRoot: project })(api);
 t.after(() => fire("session_shutdown"));
 await fire("session_start");
 assert.equal(queryMarkdownDatastoreCapability(api.events)?.ready, false);
 const client = createMarkdownDatastoreClient(api.events);
 await assert.rejects(client.status({ store: "telegram" }), { code: "INDEX_CORRUPT" });
 await assert.rejects(client.tags({ store: "telegram-group" }), { code: "INDEX_CORRUPT" });
 await fire("session_shutdown");
 await initializeTerminalHistory(state);
 await fire("session_start");
 assert.equal(queryMarkdownDatastoreCapability(api.events)?.ready, true);
 const privateStatus = await client.status({ store: "telegram" }); assert.equal(privateStatus.bounds.maxBytes, null);
 const groupStatus = await client.status({ store: "telegram-group" }); assert.equal(groupStatus.data.stores[0].capabilities.metadata.state, "ready");
 const tags = await client.tags({ store: "telegram-group" }); assert.equal((tags.data.tags as any[])[0].identity, "shared"); assert.equal(tags.bounds.maxBytes, null);
 const direct = await client.read({ note: { store: "telegram", path: "one.md" } }); assert.equal(direct.data.content, "Private fixture text.\n");
});
