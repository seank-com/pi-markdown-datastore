import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createQmdFixture } from "./fixtures/qmd-fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.PI_CODING_AGENT_PACKAGE ?? join(root, "node_modules/@earendil-works/pi-coding-agent");

test("actual tarball loads standalone, imports helpers, and runs its adjacent worker asset", { timeout: 60_000 }, async t => {
  const consumer = await mkdtemp(join(tmpdir(), "datastore-packed-consumer-"));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", consumer], { cwd: root, encoding: "utf8", timeout: 30_000 }))[0];
  const paths = packed.files.map((file: { path: string }) => file.path);
  assert.ok(paths.includes("dist/index.js")); assert.ok(paths.includes("dist/qmd-worker.mjs"));
  assert.ok(paths.every((path: string) => /^(dist\/[^/]+\.(js|mjs|d\.ts)|docs\/[^/]+\.md|README\.md|LICENSE|package\.json)$/.test(path)), paths.join("\n"));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // A lockfile install does not cache the registry metadata needed by a new
  // consumer. Resolve package dependencies with a fresh, disposable cache so
  // this test cannot depend on metadata left by previous local installations.
  execFileSync("npm", ["install", "--cache", join(consumer, "npm-cache"), "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(consumer, packed.filename)], { cwd: consumer, stdio: "pipe", timeout: 30_000 });
  await writeFile(join(consumer, "types.ts"), `
import type { NoteRef, MarkdownDatastoreCapability, MarkdownDatastorePolicyV1 } from "@seank/pi-markdown-datastore/contract";
import { createMarkdownDatastoreClient, queryMarkdownDatastoreCapability, type MarkdownDatastoreCapabilityBus } from "@seank/pi-markdown-datastore/client";
const note: NoteRef = {store:"notes",path:"one.md"};
declare const bus: MarkdownDatastoreCapabilityBus;
const capability: MarkdownDatastoreCapability | undefined = queryMarkdownDatastoreCapability(bus);
void createMarkdownDatastoreClient(bus).read({note});
const policy: MarkdownDatastorePolicyV1 = createMarkdownDatastoreClient(bus, { capability });
void policy.roots({}); void policy.validateDestination({ path: "/example/new.md" });
`);
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--module", "NodeNext", "--target", "ES2023", "types.ts"], { cwd: consumer, stdio: "pipe", timeout: 30_000 });
  const configDir = join(consumer, ".pi/markdown-datastore");
  await mkdir(configDir, { recursive: true, mode: 0o700 }); await chmod(configDir, 0o700);
  await mkdir(join(consumer, "notes")); await mkdir(join(consumer, "home"));
  await writeFile(join(consumer, "notes/one.md"), "# One\nPacked source text\n");
  const config = { schemaVersion: 1, defaults: { maxResultBytes: 4096, maxResultLines: 100, operationTimeoutMs: 1000 },
    qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" },
    stores: { notes: { root: "notes", include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } } },
  };
  await writeFile(join(configDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const sdkRoot = await createQmdFixture(consumer);
  await writeFile(join(consumer, "probe.ts"), `
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKDOWN_DATASTORE_REQUEST_EVENT, MARKDOWN_DATASTORE_CAPABILITY_REQUEST } from "@seank/pi-markdown-datastore/contract";
import { createMarkdownDatastoreClient, queryMarkdownDatastoreCapability } from "@seank/pi-markdown-datastore/client";
assert.equal(MARKDOWN_DATASTORE_REQUEST_EVENT, "pi-markdown-datastore:v1:request");
for (const name of ["@earendil-works", "typebox", "@tobilu/qmd", "@seank/pi-observability", "@seank/pi-telegram-owner"]) assert.equal(existsSync(join("node_modules",name)), false, name);
const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(join(process.env.TEST_PI_HOST!, "dist/core/extensions/loader.js")).href);
const { createEventBus } = await import(pathToFileURL(join(process.env.TEST_PI_HOST!, "dist/core/event-bus.js")).href);
const bus = createEventBus();
const entry = join(process.cwd(), "node_modules/@seank/pi-markdown-datastore/dist/index.js");
const ctx = { cwd:process.cwd(),isProjectTrusted:()=>true,ui:{setStatus(){}} };
const start = async loaded => {
  const entries = []; loaded.runtime.appendEntry = (customType,data) => { entries.push({customType,data}); };
  for (const extension of loaded.extensions) for (const handler of extension.handlers.get("session_start") ?? []) await handler({reason:"startup"},ctx);
  for (const extension of loaded.extensions) for (const handler of extension.handlers.get("resources_discover") ?? []) await handler({cwd:process.cwd(),reason:"startup"},ctx);
};
const stop = async loaded => { for (const extension of loaded.extensions) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({},ctx); };
const loaded = await loadExtensions([entry],process.cwd(),bus);
assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,1);
assert.equal(queryMarkdownDatastoreCapability(bus)?.ready,false);
await start(loaded);
assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(),["datastore_find","datastore_read","datastore_refresh","datastore_search","datastore_status"]);
const capability = queryMarkdownDatastoreCapability(bus)!;
assert.equal(capability.ready,true);assert.deepEqual(capability.stores,["notes"]);
assert.equal(capability.policyVersion,1);
const policy = createMarkdownDatastoreClient(bus,{capability,timeoutMs:1000});
assert.equal((await policy.roots({})).data.roots[0].path,join(process.cwd(),"notes"));
assert.equal((await policy.validateDestination({path:join(process.cwd(),"notes/new/deep.md")})).data.owned,true);
assert.equal((await policy.validateDestination({path:join(process.cwd(),"beside.md")})).data.owned,false);
const client = createMarkdownDatastoreClient(bus,{timeoutMs:1000});
const read = await client.read({note:{store:"notes",path:"one.md"}});
assert.match(read.data.content,/Packed source text/);
assert.equal((await client.find({store:"notes",selectors:[{kind:"path",path:"one.md"}]})).data.candidates.length,1);
await assert.rejects(client.read({note:{store:"other",path:"one.md"}}),error=>error.code==="STORE_UNKNOWN");
await assert.rejects(client.search({store:"notes",query:"source"}),error=>error.code==="CAPABILITY_UNAVAILABLE");
assert.equal((await client.refresh({store:"notes",mode:"direct"})).operation,"refresh");
await stop(loaded);assert.equal(capability.ready,false);assert.deepEqual(capability.stores,[]);
await assert.rejects(policy.roots({}),error=>error.code==="CAPABILITY_UNAVAILABLE");
assert.equal(queryMarkdownDatastoreCapability(bus),undefined);

// Resolve capabilities at the real post-start discovery event, in both load orders.
const consumerEntry = join(process.cwd(),"consumer.ts");
writeFileSync(consumerEntry,'import {join} from "node:path";import {queryMarkdownDatastoreCapability,createMarkdownDatastoreClient} from "@seank/pi-markdown-datastore/client";export default function(pi){pi.on("resources_discover",async()=>{const capability=queryMarkdownDatastoreCapability(pi.events);if(!capability?.ready||capability.policyVersion!==1)throw new Error("policy unavailable");const client=createMarkdownDatastoreClient(pi.events,{capability});const roots=(await client.roots({})).data.roots;const owned=(await client.validateDestination({path:join(process.cwd(),"notes/new.md")})).data.owned;const outside=(await client.validateDestination({path:join(process.cwd(),"beside.md")})).data.owned;pi.events.emit("fixture:ready",{ready:capability.ready,stores:capability.stores,roots:roots.map(root=>root.path),owned,outside});});}');
for (const order of [[consumerEntry,entry],[entry,consumerEntry]]) {
  clearExtensionCache();const pair=await loadExtensions(order,process.cwd(),bus);assert.deepEqual(pair.errors,[]);
  let observed;const unsubscribe=bus.on("fixture:ready",data=>{observed=data;});
  await start(pair);assert.deepEqual(observed,{ready:true,stores:["notes"],roots:[join(process.cwd(),"notes")],owned:true,outside:false});
  await stop(pair);unsubscribe();assert.equal(queryMarkdownDatastoreCapability(bus),undefined);
}

// Exercise the copied worker through the installed client, never the source tree.
const {QmdWorkerClient}=await import(pathToFileURL(join(process.cwd(),"node_modules/@seank/pi-markdown-datastore/dist/qmd-worker-client.js")).href);
const worker=new QmdWorkerClient(1000);
const request={version:2,sdkUrl:pathToFileURL(join(process.env.TEST_QMD_ROOT!,"sdk.mjs")).href,dbPath:join(process.cwd(),"fixture-index.sqlite"),config:{collections:{notes:{path:join(process.cwd(),"notes"),pattern:"**/*.md",ignore:[],includeByDefault:false}}},operation:"refresh",collections:["notes"],semantic:false};
try {
  const refreshed=await worker.request(request,{progressive:true});assert.equal(refreshed.status.totalDocuments,1);
  const pid=worker.processId;assert.ok(pid);
  const found=await worker.request({...request,operation:"search",collections:undefined,semantic:undefined,collection:"notes",query:"Packed",mode:"lexical",limit:5});
  assert.equal(found.results[0].uri,"qmd://notes/one.md");
  await worker.shutdown();assert.equal(worker.processId,undefined);
  assert.throws(()=>process.kill(pid,0));
} finally { await worker.shutdown(); }
assert.equal(readFileSync("notes/one.md","utf8"),"# One\\nPacked source text\\n");

// A configured but missing backend must preserve the direct service on reload.
const configPath=join(process.cwd(),".pi/markdown-datastore/config.json");
const config=JSON.parse(readFileSync(configPath,"utf8"));config.qmd={enabled:true,installation:{packageRoot:join(process.cwd(),"absent-qmd")},minimumVersion:"2.8.3"};
writeFileSync(configPath,JSON.stringify(config));
clearExtensionCache();const reloaded=await loadExtensions([entry],process.cwd(),bus);assert.deepEqual(reloaded.errors,[]);await start(reloaded);
assert.equal(queryMarkdownDatastoreCapability(bus)?.ready,true);
assert.match((await client.read({note:{store:"notes",path:"one.md"}})).data.content,/Packed source text/);
await assert.rejects(client.search({store:"notes",query:"source"}),error=>error.code==="CAPABILITY_UNAVAILABLE");
assert.equal((await client.status({store:"notes"})).data.stores[0].capabilities.search.lexical.reasonCode,"BACKEND_MISSING");
await stop(reloaded);assert.equal(queryMarkdownDatastoreCapability(bus),undefined);
`);
  execFileSync(process.execPath, [join(consumer, "probe.ts")], {
    cwd: consumer, env: { ...process.env, HOME: join(consumer, "home"), PI_CODING_AGENT_DIR: join(consumer, "profile"), TEST_PI_HOST: host, TEST_QMD_ROOT: sdkRoot },
    stdio: "pipe", timeout: 30_000,
  });
});
