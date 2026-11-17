import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { ContinuationRegistry } from "../src/continuations.ts";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { MetadataIndex, registerMetadata } from "../src/metadata-index.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
import { startSharedHost } from "../src/shared-host.ts";

async function fixture(t: any, shared = false) {
 const root = await realpath(await mkdtemp("/tmp/budget-boundaries-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const notes = join(root, "notes"), dir = join(root, ".pi/markdown-datastore");
 await mkdir(notes); await mkdir(dir, { recursive: true, mode: 0o700 });
 await writeFile(join(notes, "alpha.md"), Array.from({ length: 30 }, (_, i) => `[[n${i}.md|${"alias".repeat(20)}${i}]]`).join("\n"));
 for (let i = 0; i < 30; i++) await writeFile(join(notes, `n${i}.md`), `---\ntags: [shared, tag${i}${"x".repeat(50)}]\n---\nTarget.\n`);
 const path = join(dir, "config.json");
 await writeFile(path, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 4096, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notes: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 200000, search: { defaultMode: "lexical", qmdCollection: "notes" } } } }), { mode: 0o600 });
 let config = await loadMarkdownDatastoreConfig(root, path);
 const continuations = new ContinuationRegistry(4);
 let service: MarkdownDatastoreService, coordinator: MaintenanceCoordinator;
 if (shared) {
  const catalogPath = join(root, "catalog.json"), store = config.stores.get("notes")!;
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, socketPath: join(root, "owner.sock"), stateRoot: join(root, "host-state"), defaults: config.defaults, qmd: config.qmd, stores: { canonical: { root: notes, include: store.include, exclude: store.exclude, maxFileBytes: store.maxFileBytes, search: store.search } } }), { mode: 0o600 });
  const host = await startSharedHost(catalogPath);
  t.after(() => host.close());
  coordinator = host.coordinators.get("canonical")!;
  await coordinator.enqueue("metadata", ["canonical"]); await coordinator.settled();
  await writeFile(path, JSON.stringify({ schemaVersion: 1, defaults: config.defaults, qmd: config.qmd, stores: { notes: { shared: { catalog: catalogPath, store: "canonical" } } } }), { mode: 0o600 });
  config = await loadMarkdownDatastoreConfig(root, path);
  const attachment = config.stores.get("notes")!.shared!;
  service = new MarkdownDatastoreService(config, continuations, undefined, new Map([["notes", new SharedIndexClient(attachment)]]));
 } else {
  const index = new MetadataIndex(join(root, "index")); await index.rebuild(config.stores.get("notes")!);
  coordinator = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["notes"]));
  const indexes = new Map([["notes", index]]); registerMetadata(coordinator, indexes, config.stores);
  service = new MarkdownDatastoreService(config, continuations); service.bindMetadata(coordinator, indexes);
 }
 t.after(() => service.shutdown());
 return { service, notes, continuations, coordinator };
}
function fits(result: any, maxBytes: number) {
 assert.equal(result.bounds.maxBytes, maxBytes);
 assert.equal(result.bounds.returnedBytes, Buffer.byteLength(JSON.stringify(result)));
 assert(result.bounds.returnedBytes <= maxBytes);
}

for (const shared of [false, true]) test(`${shared ? "shared" : "private"} tag and graph pages honor changing caller budgets and retain every item`, async t => {
 const { service } = await fixture(t, shared);
 for (const operation of ["tags", "links"] as const) {
  const seen = new Set<string>(); let continuation: string | undefined;
  do {
   const maxBytes = continuation ? 1800 : 2400;
   const result = operation === "tags" ? await service.tags({ store: "notes", continuation, maxBytes }) : await service.read({ ...(continuation ? { continuation } : { note: { store: "notes", path: "alpha.md" }, view: "links" as const }), maxBytes });
   fits(result, maxBytes);
   const items = (operation === "tags" ? result.data.tags : result.data.edges) as any[];
   assert(items.length > 0, "a partial page must advance");
   for (const item of items) { const key = operation === "tags" ? item.identity : item.raw; assert(!seen.has(key)); seen.add(key); }
   continuation = result.bounds.continuation;
  } while (continuation);
  assert.equal(seen.size, operation === "tags" ? 31 : 30);
 }
 const found = new Set<string>(); let findToken: string | undefined;
 do {
  const result = await service.find({ store: "notes", selectors: [{ kind: "tag", value: "shared" }], continuation: findToken, maxBytes: 2400 });
  fits(result, 2400); assert(result.data.candidates.length > 0);
  for (const candidate of result.data.candidates) { assert(!found.has(candidate.note.path)); found.add(candidate.note.path); }
  findToken = result.bounds.continuation;
 } while (findToken);
 assert.equal(found.size, 30);
 const larger = await service.tags({ store: "notes", maxBytes: 20000 });
 fits(larger, 20000); assert.equal(larger.bounds.truncated, false); assert.equal((larger.data.tags as any[]).length, 31);
});

test("read fitting allocates only returned continuations and does not impose a retry count", async t => {
 const { service, notes, continuations } = await fixture(t);
 await writeFile(join(notes, "large.md"), "# " + "T".repeat(100000) + "\nTail.\n");
 const whole = await service.read({ note: { store: "notes", path: "large.md" }, maxBytes: 500000, maxLines: 100 });
 const template = structuredClone(whole);
 template.data.content = "";
 template.bounds = { maxBytes: 1, maxLines: 100, returnedBytes: 1, returnedLines: 1, truncated: true, continuation: "0".repeat(32) };
 let budget = 1;
 for (;;) { template.bounds.maxBytes = budget; template.bounds.returnedBytes = budget; const next = Buffer.byteLength(JSON.stringify(template)) + 32; if (next === budget) break; budget = next; }
 const page = await service.read({ note: { store: "notes", path: "large.md" }, maxBytes: budget, maxLines: 100 });
 fits(page, budget); assert(String(page.data.content).length > 0); assert.equal(continuations.size, 1);
 const token = page.bounds.continuation!;
 await assert.rejects(service.read({ note: { store: "notes", path: "large.md" }, maxBytes: 1 }), { code: "RESULT_LIMIT_EXCEEDED" });
 assert.equal(continuations.size, 1, "failed fitting must not allocate or evict tokens");
 assert.equal(continuations.getRead(token).note.path, "large.md");
});

test("a one-line page includes its terminator without exceeding its logical line budget", async t => {
 const { service, notes } = await fixture(t);
 await writeFile(join(notes, "lines.md"), "one\ntwo\nthree\n");
 let continuation: string | undefined; let reconstructed = "";
 do {
  const result = await service.read({ ...(continuation ? { continuation } : { note: { store: "notes", path: "lines.md" } }), maxBytes: 3000, maxLines: 1 });
  assert.equal(result.bounds.returnedLines, 1);
  assert.match(String(result.data.content), /^[^\n]+\n$/);
  reconstructed += result.data.content;
  continuation = result.bounds.continuation;
 } while (continuation);
 assert.equal(reconstructed, "one\ntwo\nthree\n");
});

test("all shared admissions remain identifiable when a finite response fails, and invalid budgets admit nothing", async t => {
 const { service } = await fixture(t);
 const ids = ["ab".repeat(16), "cd".repeat(16)]; let admissions = 0;
 const base = service.config.stores.get("notes")!;
 const stores = new Map(ids.map((_id, i) => ["alias" + i, { ...base, name: "alias" + i, shared: { catalog: "fixture", socketPath: "fixture", definitionRevision: "fixture", store: "canonical" + i } }]));
 const clients = new Map(ids.map((refreshId, i) => ["alias" + i, { startLexical: async () => { admissions++; return { refreshId }; }, shutdown: async () => {} } as unknown as SharedIndexClient]));
 const subject = new MarkdownDatastoreService({ ...service.config, stores }, undefined, undefined, clients);
 t.after(() => subject.shutdown());
 await assert.rejects(subject.refresh({ mode: "lexical", maxBytes: -1 }), { code: "RESULT_LIMIT_EXCEEDED" });
 assert.equal(admissions, 0);
 await assert.rejects(subject.refresh({ mode: "lexical", maxBytes: 1 }), (error: unknown) => {
  const result = error as { code: string; details: { operationApplied: boolean; refreshIds: string[] }; message: string };
  assert.equal(result.code, "RESULT_LIMIT_EXCEEDED"); assert.equal(result.details.operationApplied, true);
  assert.deepEqual(result.details.refreshIds, ids); for (const id of ids) assert(result.message.includes(id));
  return true;
 });
 assert.equal(admissions, 2);
});
