import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { MARKDOWN_DATASTORE_REQUEST_EVENT } from "../src/contract.ts";
import { createMarkdownDatastoreExtension } from "../src/index.ts";
import { createMarkdownDatastoreClient } from "../src/client.ts";

async function fixture(t: test.TestContext) {
	const project = await mkdtemp(join(tmpdir(), "datastore-facade-")); t.after(() => rm(project, { recursive: true, force: true }));
	const directory = join(project, ".pi", "markdown-datastore"); const notes = join(project, "notes"); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); await mkdir(notes, { mode: 0o700 }); await writeFile(join(notes, "one.md"), "# One\nBody\n");
	const configPath = join(directory, "config.json"); await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 4096, maxResultLines: 100, operationTimeoutMs: 1000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { memory: { root: "notes", include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "memory" } } } }), { mode: 0o600 }); await chmod(configPath, 0o600);
	return { project, configPath };
}

function harness(project: string, trusted = true) {
	const emitter = new EventEmitter(); const handlers = new Map<string, Function[]>(); const tools: any[] = []; const entries: any[] = []; const statuses: any[] = [];
	const pi: any = { events: { emit: (channel: string, data: unknown) => emitter.emit(channel, data), on: (channel: string, handler: (data: unknown) => void) => { emitter.on(channel, handler); return () => emitter.off(channel, handler); } }, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerTool(tool: any) { tools.push(tool); }, appendEntry(type: string, data: unknown) { entries.push({ type, data }); } };
	const ctx: any = { cwd: project, isProjectTrusted: () => trusted, ui: { setStatus: (...args: unknown[]) => statuses.push(args) } };
	const fire = async (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	return { pi, ctx, tools, entries, statuses, emitter, fire };
}

test("client RPC and direct search permit slow reranking and propagate deadline cancellation", async (t) => {
	const current = await fixture(t);
	const raw = JSON.parse(await readFile(current.configPath, "utf8"));
	raw.qmd.enabled = true; raw.defaults.operationTimeoutMs = 30_000;
	await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 });
	let entered!: () => void; let release!: () => void; let active = false;
	const qmd: any = {
		binding: { version: "2.8.3" }, startupReconcile: async () => undefined, shutdown: async () => undefined,
		isLexicallyCurrent: () => true,
		async search(_store: unknown, _query: string, _mode: string, _limit: number, _score: unknown, signal: AbortSignal) {
			active = true;
			await new Promise<void>((resolve, reject) => {
				const abort = () => { active = false; reject(signal.reason); };
				signal.addEventListener("abort", abort, { once: true });
				release = () => { active = false; signal.removeEventListener("abort", abort); resolve(); };
				entered();
			});
			return { candidates: [], generation: "fixture", manifest: { semanticAt: new Date().toISOString(), pendingEmbeddings: 0, hasVectorIndex: true, stores: {} } };
		},
	};
	const app = harness(current.project);
	createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath, createQmd: async () => qmd })(app.pi);
	await app.fire("session_start"); t.after(() => app.fire("session_shutdown"));
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const client = createMarkdownDatastoreClient(app.pi.events);
	const clientTool = { execute: async (_id: string, input: any, signal: AbortSignal) => ({ content: [{ text: JSON.stringify(await client.search(input, signal)) }] }) };
	for (const name of ["datastore_search", "client_search"]) {
		const tool = name === "client_search" ? clientTool : app.tools.find((item) => item.name === name);
		const input = { store: "memory", query: "decision", mode: "hybrid" };
		let ready = new Promise<void>((resolve) => { entered = resolve; });
		const slow = tool.execute("slow", input, new AbortController().signal);
		await ready; t.mock.timers.tick(19_000); release();
		assert.equal(JSON.parse((await slow).content[0].text).operation, "search");
		ready = new Promise<void>((resolve) => { entered = resolve; });
		const expired = tool.execute("expired", input, new AbortController().signal);
		const rejected = assert.rejects(expired, (error: any) => error.code === "TIMEOUT");
		await ready; t.mock.timers.tick(900_000); await rejected;
		assert.equal(active, false, `${name} must stop backend work at its deadline`);
		ready = new Promise<void>((resolve) => { entered = resolve; });
		const controller = new AbortController();
		const cancelled = tool.execute("cancelled", input, controller.signal);
		const cancellation = assert.rejects(cancelled, (error: any) => error.code === "CANCELLED" || error.name === "AbortError");
		await ready; controller.abort(); await cancellation;
		assert.equal(active, false);
	}
});

test("trusted valid configuration registers exactly five strict tools", async (t) => {
	const current = await fixture(t); const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath })(app.pi); await app.fire("session_start", { reason: "startup" });
	assert.deepEqual(app.tools.map((tool) => tool.name), ["datastore_search", "datastore_find", "datastore_read", "datastore_status", "datastore_refresh"]);
	for (const tool of app.tools) {
		if (tool.parameters.type === "object") assert.equal(tool.parameters.additionalProperties, false);
		else for (const schema of tool.parameters.anyOf) assert.equal(schema.additionalProperties, false);
	}
	const read = app.tools.find((tool) => tool.name === "datastore_read");
	assert.equal(read.parameters.type, "object"); assert.equal(read.parameters.anyOf.length, 4);
	assert.equal(Check(read.parameters, { note: { store: "memory", path: "one.md" }, includeFrontmatter: true }), true);
	assert.equal(Check(read.parameters, { note: { store: "memory", path: "one.md" }, view: "metadata", includeFrontmatter: false }), false);
	assert.equal(Check(read.parameters, { note: { store: "memory", path: "one.md" }, view: "related", includeSemanticRelated: true }), false);
	assert.equal(Check(read.parameters, { note: { store: "memory", path: "one.md" }, view: "metadata", includeSemanticRelated: false }), false);
	const result = await read.execute("id", { note: { store: "memory", path: "one.md" }, view: "content" }, new AbortController().signal);
	assert.match(result.content[0].text, /Body/); assert.equal(result.details.operation, "read");
	assert.deepEqual(app.entries.map((entry) => entry.data.phase), ["start", "end"]); const metric = app.entries[1].data; assert.equal(metric.returnedCount, 1); assert.equal(metric.returnedBytes, 11); assert.equal(metric.returnedLines, 3); assert.equal(metric.maxBytes, 4096); assert.equal(metric.maxLines, 100); assert.equal(metric.truncated, false); assert.equal(metric.cacheHit, undefined); assert.deepEqual(metric.backendSelection, ["filesystem"]); assert.deepEqual(metric.freshnessStates, ["current"]); assert.deepEqual(metric.warningCodes, []); assert.equal(metric.outputSchema, "valid");
	assert.ok(app.entries.every((entry) => !JSON.stringify(entry).includes("one.md") && !JSON.stringify(entry).includes("Body")));
});

test("refresh end metrics include only structural counts and backend state", async (t) => {
	const current = await fixture(t); const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath })(app.pi); await app.fire("session_start"); const refresh = app.tools.find((tool) => tool.name === "datastore_refresh"); await refresh.execute("id", { store: "memory", mode: "direct" }, new AbortController().signal); const metric = app.entries.filter((entry) => entry.type === "markdown-datastore-operation" && entry.data.phase === "end").at(-1).data; assert.equal(metric.refreshCount, 1); assert.equal(metric.returnedCount, 1); assert.deepEqual(metric.backendSelection, ["filesystem"]); assert.deepEqual(metric.warningCodes, []); assert.equal(metric.outputSchema, "valid"); assert.ok(metric.returnedBytes <= metric.maxBytes); assert.ok(metric.returnedLines <= metric.maxLines); assert.ok(!JSON.stringify(metric).includes("one.md") && !JSON.stringify(metric).includes("Body"));
});

test("qmd startup reconciliation is enqueued without blocking startup", { timeout: 5000 }, async (t) => {
	const current = await fixture(t); const raw = JSON.parse(await readFile(current.configPath, "utf8")); raw.qmd.enabled = true; await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 }); let started = false; let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
	const qmd: any = { binding: { version: "2.8.3" }, startupReconcile: async () => { started = true; await pending; }, shutdown: async () => { release(); } }; const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath, createQmd: async () => qmd })(app.pi); const before = Date.now(); await app.fire("session_start");
	assert.equal(started, true); assert.ok(Date.now() - before < 100); assert.equal(app.tools.length, 5); await app.fire("session_shutdown");
});

test("missing configuration and untrusted projects register no datastore tools", async (t) => {
	const current = await fixture(t); const missing = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: join(current.project, ".pi", "markdown-datastore", "absent.json") })(missing.pi); await missing.fire("session_start"); assert.equal(missing.tools.length, 0);
	const untrusted = harness(current.project, false); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath })(untrusted.pi); await untrusted.fire("session_start"); assert.equal(untrusted.tools.length, 0);
});

test("event RPC rejects unknown fields, malformed inputs, and expired deadlines", { timeout: 5000 }, async (t) => {
	const current = await fixture(t); const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath })(app.pi); await app.fire("session_start");
	const call = (payload: Record<string, unknown>) => new Promise<any>((resolve, reject) => app.emitter.emit(MARKDOWN_DATASTORE_REQUEST_EVENT, { contractVersion: 1, requestId: "strict-request", deadline: Date.now() + 1000, resolve, reject, ...payload }));
	await assert.rejects(() => call({ request: { operation: "status", input: { unexpected: true } } }), (error: any) => error.code === "CONFIG_INVALID");
	await assert.rejects(() => call({ request: { operation: "read", input: { note: { store: "memory", path: "one.md" }, view: "metadata", includeFrontmatter: false } } }), (error: any) => error.code === "CONFIG_INVALID");
	await assert.rejects(() => call({ request: { operation: "read", input: { note: { store: "memory", path: "one.md" }, view: "outline", excludeSections: [] } } }), (error: any) => error.code === "CONFIG_INVALID");
	const refreshId = "0123456789abcdef0123456789abcdef";
	await assert.rejects(() => call({ request: { operation: "refresh", input: { refreshId } } }), (error: any) => error.code === "CONFIG_INVALID");
	await assert.rejects(() => call({ request: { operation: "refresh", input: { action: "start", refreshId } } }), (error: any) => error.code === "CONFIG_INVALID");
	await assert.rejects(() => call({ request: { operation: "refresh", input: { action: "cancel", refreshId, mode: "semantic" } } }), (error: any) => error.code === "CONFIG_INVALID");
	await assert.rejects(() => call({ request: { operation: "status", input: {} }, unexpected: true }), (error: any) => error.code === "CONFIG_INVALID");
	await assert.rejects(() => call({ request: { operation: "status", input: {} }, deadline: Date.now() - 1 }), (error: any) => error.code === "TIMEOUT");
	assert.ok(app.entries.filter((entry) => entry.type === "markdown-datastore-rpc").every((entry) => !JSON.stringify(entry).includes("strict-request")));
});

test("status observability labels unreconciled validated qmd state stale", async (t) => {
	const current = await fixture(t); const raw = JSON.parse(await readFile(current.configPath, "utf8")); raw.qmd.enabled = true; await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 }); const job = { version: 1, refreshId: "d".repeat(32), key: "lexical:memory", mode: "lexical", stores: ["memory"], ownership: "startup-reconciliation", state: "queued", phase: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: { documentsCompleted: 0, sourceBytesCompleted: 0, chunksCompleted: 0, embeddingBytesCompleted: 0, errors: 0 } }; const activity = { state: "queued", active: false, queued: true, jobs: [job] }; const qmd: any = { binding: { version: "2.8.3" }, startupReconcile: async () => job, activity: () => activity, status: async () => ({ state: "ready", stores: { memory: { documentCount: 1, runtimeLexicalCurrent: false } }, reconciliation: activity, pendingEmbeddings: 1, hasVectorIndex: false }), shutdown: async () => undefined };
	const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath, createQmd: async () => qmd })(app.pi); await app.fire("session_start"); const statusTool = app.tools.find((tool) => tool.name === "datastore_status"); const result = await statusTool.execute("id", { store: "memory" }, new AbortController().signal); assert.equal(JSON.parse(result.content[0].text).data.stores[0].sourceReconciliation.state, "queued"); const metric = app.entries.filter((entry) => entry.type === "markdown-datastore-operation" && entry.data.phase === "end").at(-1).data; assert.deepEqual(metric.freshnessStates, ["stale"]); await app.fire("session_shutdown");
});

test("status remains bounded with retained durable refresh history", async (t) => {
	const current = await fixture(t); const raw = JSON.parse(await readFile(current.configPath, "utf8")); raw.qmd.enabled = true; await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 });
	const jobs = Array.from({ length: 20 }, (_, index) => ({ version: 1, refreshId: index.toString(16).padStart(32, "0"), key: "lexical:memory", mode: "lexical", stores: ["memory"], ownership: "startup-reconciliation", state: "succeeded", phase: "succeeded", createdAt: "2026-09-29T00:00:00.000Z", updatedAt: `2026-09-29T00:00:${String(index).padStart(2, "0")}.000Z`, completedAt: `2026-09-29T00:00:${String(index).padStart(2, "0")}.000Z`, generation: `gen-${index.toString(16).padStart(32, "0")}`, progress: { documentsCompleted: 11037, documentsTotal: 11037, sourceBytesCompleted: 24003994, sourceBytesTotal: 24003994, chunksCompleted: 0, embeddingBytesCompleted: 0, errors: 0 } }));
	const activity = { state: "succeeded", active: false, queued: false, jobs }; const qmd: any = { binding: { version: "2.8.3" }, startupReconcile: async () => jobs[0], activity: () => activity, status: async () => ({ state: "ready", version: "2.8.3", generation: jobs[0].generation, stores: { memory: { documentCount: 11037, runtimeLexicalCurrent: true } }, refresh: activity, reconciliation: activity, pendingEmbeddings: 0, hasVectorIndex: true }), shutdown: async () => undefined };
	const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath, createQmd: async () => qmd })(app.pi); await app.fire("session_start"); const statusTool = app.tools.find((tool) => tool.name === "datastore_status"); const result = await statusTool.execute("id", { store: "memory" }, new AbortController().signal); const parsed = JSON.parse(result.content[0].text); const store = parsed.data.stores[0]; assert.equal(store.sourceReconciliation.job.refreshId, jobs[0].refreshId); assert.deepEqual(store.qmd.refresh, { state: "succeeded", active: false, queued: false }); assert.equal(store.qmd.stores, undefined); assert.equal(store.qmd.reconciliation, undefined); assert.ok(Buffer.byteLength(result.content[0].text) <= 65536); await app.fire("session_shutdown");
});

test("event RPC lexical maintenance returns a prompt durable receipt", { timeout: 5000 }, async (t) => {
	const current = await fixture(t); const raw = JSON.parse(await readFile(current.configPath, "utf8")); raw.qmd.enabled = true; await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 });
	const qmd: any = { binding: { version: "2.8.3" }, startupReconcile: async () => ({ refreshId: "c".repeat(32), mode: "lexical", state: "queued" }), startLexicalRefresh: async () => ({ refreshId: "a".repeat(32), mode: "lexical", state: "queued", phase: "queued", ownership: "explicit-maintenance" }), shutdown: async () => undefined };
	const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath, createQmd: async () => qmd })(app.pi); await app.fire("session_start"); const started = Date.now();
	const result = await new Promise<any>((resolve, reject) => app.emitter.emit(MARKDOWN_DATASTORE_REQUEST_EVENT, { contractVersion: 1, requestId: "receipt", request: { operation: "refresh", input: { store: "memory", mode: "lexical" } }, deadline: Date.now() + 1000, resolve, reject }));
	assert.ok(Date.now() - started < 100); assert.equal(result.data.qmd.refreshId, "a".repeat(32)); assert.ok(app.entries.some((entry) => entry.type === "markdown-datastore-rpc" && entry.data.outcome === "success"));
});

test("duplicate RPC responders allow the first only and emit structural diagnostics", { timeout: 5000 }, async (t) => {
	const current = await fixture(t); const app = harness(current.project);
	createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath })(app.pi); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath })(app.pi); await app.fire("session_start");
	let resolutions = 0; const result = await new Promise<any>((resolve, reject) => app.emitter.emit(MARKDOWN_DATASTORE_REQUEST_EVENT, { contractVersion: 1, requestId: "duplicate", request: { operation: "status", input: {} }, deadline: Date.now() + 1000, resolve: (value: unknown) => { resolutions += 1; resolve(value); }, reject }));
	await new Promise((resolve) => setImmediate(resolve)); assert.equal(result.operation, "status"); assert.equal(resolutions, 1);
	assert.ok(app.entries.some((entry) => entry.type === "markdown-datastore-rpc" && entry.data.outcome === "duplicate-responder"));
	assert.ok(app.entries.every((entry) => !JSON.stringify(entry).includes("one.md") && !JSON.stringify(entry).includes("Body")));
});

test("repeated session_start replaces and shuts down the previous service safely", { timeout: 5000 }, async (t) => {
	const current = await fixture(t); const raw = JSON.parse(await readFile(current.configPath, "utf8")); raw.qmd.enabled = true; await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 }); let shutdowns = 0;
	const createQmd = async () => ({ binding: { version: "2.8.3" }, startupReconcile: async () => ({ refreshId: "c".repeat(32), mode: "lexical", state: "queued" }), startLexicalRefresh: async () => ({ refreshId: "b".repeat(32), mode: "lexical", state: "queued" }), shutdown: async () => { shutdowns += 1; } }) as any;
	const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath, createQmd })(app.pi); await app.fire("session_start"); await app.fire("session_start");
	assert.equal(shutdowns, 1); assert.equal(app.emitter.listenerCount(MARKDOWN_DATASTORE_REQUEST_EVENT), 1); assert.equal(app.tools.length, 5);
});

test("event RPC dispatches once and is removed on shutdown", { timeout: 5000 }, async (t) => {
	const current = await fixture(t); const app = harness(current.project); createMarkdownDatastoreExtension({ projectRoot: current.project, configPath: current.configPath })(app.pi); await app.fire("session_start");
	const result = await new Promise<any>((resolve, reject) => app.emitter.emit(MARKDOWN_DATASTORE_REQUEST_EVENT, { contractVersion: 1, requestId: "request-1", request: { operation: "read", input: { note: { store: "memory", path: "one.md" }, view: "outline" } }, deadline: Date.now() + 1000, resolve, reject }));
	assert.equal(result.operation, "read"); assert.equal(app.emitter.listenerCount(MARKDOWN_DATASTORE_REQUEST_EVENT), 1);
	await app.fire("session_shutdown", { reason: "quit" }); assert.equal(app.emitter.listenerCount(MARKDOWN_DATASTORE_REQUEST_EVENT), 0);
});

test('hybrid fallback modes and warning survive tool and owned event transport',async t=>{
 const f=await fixture(t);const raw=JSON.parse(await readFile(f.configPath,'utf8'));raw.qmd.enabled=true;await writeFile(f.configPath,JSON.stringify(raw),{mode:0o600});
 const qmd:any={binding:{version:'2.8.3'},startupReconcile:async()=>{},shutdown:async()=>{},isLexicallyCurrent:()=>true,activity:()=>({active:true,embeddingActive:true,jobs:[]}),search:async()=>({requestedMode:'hybrid',effectiveMode:'lexical',queueMs:1,operationMs:2,workerId:123,embeddingActive:true,candidates:[],generation:'fixture',semanticSnapshotStale:false,manifest:{pendingEmbeddings:1,hasVectorIndex:false,stores:{memory:{}}}})};
 const app=harness(f.project);createMarkdownDatastoreExtension({projectRoot:f.project,configPath:f.configPath,createQmd:async()=>qmd})(app.pi);await app.fire('session_start');t.after(()=>app.fire('session_shutdown'));
 const result=await app.tools.find(x=>x.name==='datastore_search').execute('id',{store:'memory',query:'copper',mode:'hybrid'},new AbortController().signal);const parsed=JSON.parse(result.content[0].text);assert.equal(parsed.data.effectiveMode,'lexical');assert.equal(parsed.data.requestedMode,'hybrid');assert.ok(parsed.warnings.some((w:any)=>w.code==='SEMANTIC_UNAVAILABLE'));
 const client=createMarkdownDatastoreClient(app.pi.events);const event=await client.search({store:'memory',query:'copper',mode:'hybrid'});assert.equal(event.data.effectiveMode,'lexical');assert.ok(event.warnings.some(w=>w.code==='SEMANTIC_UNAVAILABLE'));
});
