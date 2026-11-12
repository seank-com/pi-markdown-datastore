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
	await app.fire("session_start");
	t.after(() => app.fire("session_shutdown"));
	const tags = app.tools.find((tool) => tool.name === "datastore_tags");
	const read = app.tools.find((tool) => tool.name === "datastore_read");
	const refresh = app.tools.find((tool) => tool.name === "datastore_refresh");
	assert.ok(tags && read && refresh);
	await refresh.execute("1", { store: "memory", mode: "metadata" }, new AbortController().signal);
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try { await tags.execute("2", { store: "memory" }, new AbortController().signal); break; }
		catch (error: any) { if (error?.code !== "STALE_INDEX" || attempt === 19) throw error; await new Promise((resolve) => setTimeout(resolve, 25)); }
	}
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
	const catalog = JSON.parse((await tags.execute("4", { store: "memory" }, new AbortController().signal)).content[0].text);
	assert.equal(catalog.operation, "tags");
	assert.equal(catalog.data.tags[0].identity, "travel");
	assert.equal(catalog.data.tags[0].spelling, "Travel");
	assert.equal(catalog.data.tags[0].pageCount, 1);
	assert.equal("pages" in catalog.data.tags[0], false);
	await assert.rejects(tags.execute("5", { store: "memory", continuation: Buffer.from(JSON.stringify({ store: "memory", revision: "meta-" + "0".repeat(32), query: "catalog", offset: 0 })).toString("base64url") }, new AbortController().signal), { code: "STALE_CONTINUATION" });
	const client = createMarkdownDatastoreClient(app.pi.events, { timeoutMs: 3000 });
	const viaClient = await client.tags({ store: "memory" });
	assert.equal(viaClient.operation, "tags");
	assert.equal(viaClient.data.tags[0].pageCount, 1);
});

test("shared socket detach leaves the accepted metadata job, and explicit cancel is separate", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-detach-")));
	const socketDir = join(root, "sock");
	await mkdir(socketDir, { recursive: true, mode: 0o700 });
	await chmod(socketDir, 0o700);
	const notes = join(root, "notes");
	await mkdir(notes, { recursive: true });
	await writeFile(join(notes, "alpha.md"), "See [[beta]].\n");
	await writeFile(join(notes, "beta.md"), "Target.\n");
	const state = join(root, "state");
	await mkdir(state, { mode: 0o700 });
	const catalogPath = join(root, "catalog.json");
	await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, socketPath: join(socketDir, "s.sock"), stateRoot: state, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notebook: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notebook" } } } }), { mode: 0o600 });
	const { startSharedHost } = await import("../src/shared-host.ts");
	const { loadSharedCatalog } = await import("../src/shared-catalog.ts");
	const { SharedIndexClient } = await import("../src/shared-client.ts");
	const host = await startSharedHost(catalogPath);
	t.after(() => host.close());
	t.after(() => rm(root, { recursive: true, force: true }));
	const defined = (await loadSharedCatalog(catalogPath)).stores.get("notebook")!;
	const coordinator = host.coordinators.get("notebook")!;
	let started!: () => void;
	const holding = new Promise<void>((resolve) => { started = resolve; });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	coordinator.register("metadata", async (_job, signal) => {
		started();
		await new Promise<void>((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			gate.then(resolve);
		});
		return { generation: "meta-" + "ab".repeat(16) };
	});
	const first = new SharedIndexClient({ socketPath: join(socketDir, "s.sock"), store: "notebook", definitionRevision: defined.definitionRevision });
	const receipt = await first.startMetadata();
	await holding;
	await first.shutdown();
	assert.equal(coordinator.get(String(receipt.refreshId))?.state, "running");
	const second = new SharedIndexClient({ socketPath: join(socketDir, "s.sock"), store: "notebook", definitionRevision: defined.definitionRevision });
	const again = await second.startMetadata();
	assert.equal(again.refreshId, receipt.refreshId);
	assert.equal(again.coalesced, true);
	release();
	await coordinator.settled();
	assert.equal(coordinator.get(String(receipt.refreshId))?.state, "succeeded");
	await second.shutdown();
	const cancelled = new SharedIndexClient({ socketPath: join(socketDir, "s.sock"), store: "notebook", definitionRevision: defined.definitionRevision });
	let startedAgain!: () => void;
	const holdingAgain = new Promise<void>((resolve) => { startedAgain = resolve; });
	coordinator.register("metadata", async (_job, signal) => { startedAgain(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); return { generation: "meta-" + "cd".repeat(16) }; });
	const next = await cancelled.startMetadata();
	await holdingAgain;
	await cancelled.cancel(String(next.refreshId));
	await coordinator.settled();
	assert.equal(coordinator.get(String(next.refreshId))?.state, "cancelled");
	await cancelled.shutdown();
});
