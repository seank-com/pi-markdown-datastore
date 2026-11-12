import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMarkdownDatastoreClient } from "../src/client.ts";
import { MARKDOWN_DATASTORE_REQUEST_EVENT } from "../src/contract.ts";
import { createMarkdownDatastoreExtension } from "../src/index.ts";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";

function harness(project: string) {
	const emitter = new EventEmitter();
	const handlers = new Map<string, Function[]>();
	const tools: any[] = [];
	const pi: any = {
		events: { emit: (channel: string, data: unknown) => emitter.emit(channel, data), on: (channel: string, handler: (data: unknown) => void) => { emitter.on(channel, handler); return () => emitter.off(channel, handler); } },
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: any) { tools.push(tool); },
		appendEntry() {},
	};
	const ctx: any = { cwd: project, isProjectTrusted: () => true, ui: { setStatus() {} } };
	const fire = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
	return { pi, tools, emitter, fire };
}

test("public tags tool and client page the catalog and links exactly once", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-public-meta-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notes = join(root, "notes");
	const dir = join(root, ".pi", "markdown-datastore");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	await mkdir(notes);
	const links = Array.from({ length: 4 }, (_item, index) => `[[t${index}|${"x".repeat(700)}]]`).join(" ");
	await writeFile(join(notes, "alpha.md"), `---\ntags: [Travel, Travel]\n---\n${links}\n![[map.png]]\n`);
	for (let index = 0; index < 4; index += 1) await writeFile(join(notes, `t${index}.md`), "Target.\n");
	await writeFile(join(notes, "map.png"), "not-read");
	await writeFile(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 2200, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { memory: { root: "notes", include: ["**/*.md"], exclude: [], maxFileBytes: 200000, search: { defaultMode: "lexical", qmdCollection: "memory" } } } }), { mode: 0o600 });
	const app = harness(root);
	createMarkdownDatastoreExtension({ projectRoot: root })(app.pi);
	assert.ok(app.tools.some((tool) => tool.name === "datastore_tags"));
	const { loadMarkdownDatastoreConfig } = await import("../src/config.ts");
	const { MetadataIndex, registerMetadata } = await import("../src/metadata-index.ts");
	const { MarkdownDatastoreService } = await import("../src/service.ts");
	const config = await loadMarkdownDatastoreConfig(root);
	const coordinator = new MaintenanceCoordinator(join(root, "state", "jobs.json"), () => new Set(config.stores.keys()));
	const indexes = new Map([["memory", new MetadataIndex(join(root, "state", "metadata-memory"))]]);
	registerMetadata(coordinator, indexes, config.stores);
	const service = new MarkdownDatastoreService(config);
	service.bindMetadata(coordinator, indexes);
	await service.refresh({ store: "memory", mode: "metadata" });
	await coordinator.settled();
	const read = { execute: async (_id: string, input: any) => ({ content: [{ text: JSON.stringify(await service.read(input)) }] }) };
	const seen = new Set<string>();
	let token: string | undefined;
	let occurrenceCount = 0;
	do {
		const result = JSON.parse((await read.execute("2", { store: "memory", note: { store: "memory", path: "alpha.md" }, view: "links", ...(token ? { continuation: token } : {}) })).content[0].text);
		occurrenceCount = result.data.occurrenceCount;
		for (const edge of result.data.edges) {
			assert.equal(seen.has(edge.raw + edge.line), false);
			seen.add(edge.raw + edge.line);
		}
		token = result.bounds.continuation;
	} while (token);
	assert.equal(seen.size, occurrenceCount);
	assert.ok(occurrenceCount > 1);
	const back = JSON.parse((await read.execute("3", { store: "memory", note: { store: "memory", path: "map.png" }, view: "backlinks" })).content[0].text);
	assert.equal(back.data.occurrenceCount, 1);
	assert.equal(back.data.edges[0].source, "alpha.md");
	const catalog = await service.tags({ store: "memory" });
	assert.equal(catalog.operation, "tags");
	assert.equal(catalog.data.tags[0].identity, "travel");
	assert.equal(catalog.data.tags[0].spelling, "Travel");
	assert.equal(catalog.data.tags[0].pageCount, 1);
	assert.equal("pages" in catalog.data.tags[0], false);
	await assert.rejects(service.tags({ store: "memory", continuation: Buffer.from(JSON.stringify({ store: "memory", revision: "meta-" + "0".repeat(32), query: "other", offset: 0 })).toString("base64url") }), { code: "STALE_CONTINUATION" });
	const bus = new EventEmitter();
	bus.on(MARKDOWN_DATASTORE_REQUEST_EVENT, (payload: any) => { void service.tags(payload.request.input).then(payload.resolve, payload.reject); });
	const client = createMarkdownDatastoreClient(bus as any, { timeoutMs: 3000 });
	const viaClient = await client.tags({ store: "memory" });
	assert.equal(viaClient.operation, "tags");
	assert.equal(viaClient.data.tags[0].pageCount, 1);
});

test("shared client detach does not cancel an explicit metadata job", async () => {
	const coordinator = new MaintenanceCoordinator("/tmp/does-not-write-" + process.pid + ".json", () => new Set(["notebook"]));
	let started!: () => void;
	const holding = new Promise<void>((resolve) => { started = resolve; });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	coordinator.register("metadata", async (_job, signal) => {
		started();
		await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		await gate;
		return { generation: "meta-" + "ab".repeat(16) };
	});
	const job = await coordinator.enqueue("metadata", ["notebook"], "explicit-maintenance");
	await holding;
	assert.equal(coordinator.get(String(job.refreshId))?.state, "running");
	await coordinator.cancel(String(job.refreshId));
	coordinator.shutdown();
	release();
	await coordinator.settled();
	assert.equal(coordinator.get(String(job.refreshId))?.state, "cancelled");
});
