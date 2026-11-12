import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { discoverQmdBinding, QmdAdapter } from "../src/qmd-adapter.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
import { attachSharedParser, encodeSharedMessage, listenOwnedSocket } from "../src/shared-ipc.ts";
import { createQmdFixture } from "./fixtures/qmd-fixture.ts";

async function owned(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
}

test("one maintenance implementation is hosted, not copied", async () => {
	const host = await readFile(new URL("../src/shared-host.ts", import.meta.url), "utf8");
	const adapter = await readFile(new URL("../src/qmd-adapter.ts", import.meta.url), "utf8");
	assert.match(host, /new QmdAdapter\(/);
	assert.equal(host.includes("startRefreshJob"), false);
	assert.match(adapter, /startRefreshJob/);
	assert.equal((host.match(/class /g) ?? []).length, 0);
});

test("private and shared hosts expose the same refresh coalescing and detach does not rebuild", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-shared-")));
	const socketDir = `/tmp/ds${process.pid}`;
	await mkdir(socketDir, { mode: 0o700 });
	await chmod(socketDir, 0o700);
	const socketPath = join(socketDir, "s.sock");
	let child: ReturnType<typeof spawn> | undefined;
	let privateAdapter: QmdAdapter | undefined;
	const services: MarkdownDatastoreService[] = [];
	t.after(async () => {
		await Promise.all(services.map((service) => service.shutdown()));
		await privateAdapter?.shutdown();
		if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
		await rm(socketDir, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	const notes = join(root, "notes");
	const packageRoot = await createQmdFixture(root);
	await owned(notes);
	await writeFile(join(notes, "alpha.md"), "Copper shared note.\n");
	const state = join(root, "service-state");
	await owned(state);
	const catalogPath = join(root, "catalog.json");
	await writeFile(catalogPath, JSON.stringify({
		schemaVersion: 1, socketPath, stateRoot: state,
		defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 },
		qmd: { enabled: true, installation: { packageRoot }, minimumVersion: "2.8.3" },
		stores: { notebook: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notebook" } } },
	}), { mode: 0o600 });
	const privateProject = join(root, "private-project");
	await owned(join(privateProject, ".pi", "markdown-datastore"));
	await owned(join(privateProject, "notes"));
	await writeFile(join(privateProject, "notes", "alpha.md"), "Copper private note.\n");
	const privateConfigPath = join(privateProject, ".pi", "markdown-datastore", "config.json");
	await writeFile(privateConfigPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: true, installation: { packageRoot }, minimumVersion: "2.8.3" }, stores: { memory: { root: "notes", include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "memory" } } } }), { mode: 0o600 });
	const privateConfig = await loadMarkdownDatastoreConfig(privateProject, privateConfigPath);
	privateAdapter = new QmdAdapter(privateConfig, await discoverQmdBinding(privateConfig));
	const first = await privateAdapter.startLexicalRefresh([privateConfig.stores.get("memory")!]);
	const second = await privateAdapter.startLexicalRefresh([privateConfig.stores.get("memory")!]);
	assert.equal(second.refreshId, first.refreshId);
	assert.equal(second.coalesced, true);

	child = spawn(process.execPath, ["--experimental-strip-types", "src/shared-service-main.ts", "--catalog", catalogPath], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
	let err = "";
	child.stderr.on("data", (chunk) => { err += chunk; });
	const generation = await new Promise<string>((resolve, reject) => {
		let buf = "";
		child.stdout.on("data", (chunk) => { buf += chunk; if (buf.includes("\n")) resolve(buf.split("\n")[0]); });
		child.once("exit", (code) => reject(new Error(`service exited ${code}: ${err}`)));
	});
	assert.match(generation, /^gen-/);
	assert.equal(((await lstat(socketPath)).mode & 0o077), 0);
	const project = async (name: string, alias: string) => {
		const dir = join(root, name);
		await owned(join(dir, ".pi", "markdown-datastore"));
		const configPath = join(dir, ".pi", "markdown-datastore", "config.json");
		await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { [alias]: { shared: { catalog: catalogPath, store: "notebook" } } } }), { mode: 0o600 });
		const config = await loadMarkdownDatastoreConfig(dir, configPath);
		const client = new SharedIndexClient(config.stores.get(alias)!.shared!);
		const service = new MarkdownDatastoreService(config, undefined, undefined, new Map([[alias, client]]));
		services.push(service);
		return { config, service, client, alias };
	};
	const left = await project("left", "notes-alias");
	const right = await project("right", "archive-alias");

	const leftReceipt = await left.service.refresh({ action: "start", store: left.alias, mode: "lexical" });
	const rightReceipt = await right.service.refresh({ action: "start", store: right.alias, mode: "lexical" });
	assert.equal(rightReceipt.data.qmd.refreshId, leftReceipt.data.qmd.refreshId);
	assert.equal(rightReceipt.data.qmd.coalesced, true);
	await left.service.shutdown();
	const still = await right.client.activity();
	assert.equal(still.jobs.some((job) => job.refreshId === leftReceipt.data.qmd.refreshId), true);
	const read = await right.service.read({ store: right.alias, note: { store: right.alias, path: "alpha.md" } });
	assert.match(read.data.content, /Copper shared note/);
	await right.client.shutdown();
	const stale = new SharedIndexClient({ ...right.config.stores.get(right.alias)!.shared!, definitionRevision: "0".repeat(64) });
	await assert.rejects(stale.activity(), { code: "STORE_UNAVAILABLE" });
	await stale.shutdown();
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	const after = new MarkdownDatastoreService(right.config, undefined, undefined, new Map([[right.alias, new SharedIndexClient(right.config.stores.get(right.alias)!.shared!)]]));
	services.push(after);
	await assert.rejects(after.refresh({ action: "start", store: right.alias, mode: "lexical" }), { code: "STORE_UNAVAILABLE" });
	const direct = await after.read({ store: right.alias, note: { store: right.alias, path: "alpha.md" } });
	assert.match(direct.data.content, /Copper shared note/);
	const projectState = join(root, "right", ".pi", "markdown-datastore", "state");
	await assert.rejects(lstat(projectState), { code: "ENOENT" });
});

test("a live owner socket is not replaced and a public parent is refused", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-own-")));
	await chmod(root, 0o700);
	const socketDir = `/tmp/dsown${process.pid}`;
	await mkdir(socketDir, { mode: 0o700 });
	await chmod(socketDir, 0o700);
	const socketPath = join(socketDir, "s.sock");
	let probe: ReturnType<typeof createConnection> | undefined;
	let first: Server | undefined;
	t.after(async () => {
		probe?.destroy();
		if (first) await new Promise<void>((resolve) => first!.close(() => resolve()));
		await rm(socketDir, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	});
	first = await listenOwnedSocket(socketPath, (socket) => socket.end("first"));
	await assert.rejects(listenOwnedSocket(socketPath, () => undefined), { code: "STORE_UNAVAILABLE" });
	assert.equal(first.listening, true);
	probe = createConnection(socketPath);
	const client = probe;
	client.setEncoding("utf8");
	const answer = new Promise<string>((resolve) => { let text = ""; client.on("data", (chunk) => { text += chunk; }); client.on("close", () => resolve(text)); });
	await once(client, "connect");
	assert.equal(await answer, "first");
	const publicParent = join(root, "public");
	await mkdir(publicParent, { mode: 0o777 });
	await chmod(publicParent, 0o777);
	await assert.rejects(listenOwnedSocket(join(publicParent, "index.sock"), () => undefined), { code: "CONFIG_INVALID" });
});

test("private and shared search validation emit the same warnings", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-parity-")));
	const store = { name: "notes", root, configuredRoot: root, rootWasSymlink: false, rootDev: 0, rootIno: 0, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "hybrid" as const, qmdCollection: "notes" } };
	const config: any = { schemaVersion: 1, projectRoot: root, configPath: join(root, "config.json"), stateRoot: join(root, "state"), defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: true }, stores: new Map([["notes", store]]) };
	const backend = { candidates: [], rejectedCandidates: 1, manifest: { stores: {}, pendingEmbeddings: 0, semanticAt: undefined, hasVectorIndex: false }, generation: "gen-" + "a".repeat(32), requestedMode: "hybrid", effectiveMode: "lexical", embeddingActive: true, queueMs: 0, operationMs: 0 };
	const local: any = { binding: { version: "fixture" }, activity: () => ({ embeddingActive: true }), isLexicallyCurrent: () => false, search: async () => backend, shutdown: async () => undefined };
	const remote: any = { version: "fixture", activity: async () => ({ embeddingActive: true }), isLexicallyCurrent: async () => false, search: async () => backend, shutdown: async () => undefined };
	const sharedStore = { ...store, shared: { catalog: "fixture", store: "notes", socketPath: "/tmp/unused.sock", definitionRevision: "a".repeat(64) } };
	const privateService = new MarkdownDatastoreService(config, undefined, local);
	const sharedService = new MarkdownDatastoreService({ ...config, stores: new Map([["notes", sharedStore]]) }, undefined, undefined, new Map([["notes", remote]]));
	const privateResult = await privateService.search({ store: "notes", query: "copper", mode: "hybrid" });
	const sharedResult = await sharedService.search({ store: "notes", query: "copper", mode: "hybrid" });
	assert.deepEqual(sharedResult.warnings.map((warning) => warning.code), privateResult.warnings.map((warning) => warning.code));
	await assert.rejects(privateService.search({ store: "notes", query: " ", mode: "hybrid" }), { code: "BACKEND_OUTPUT_INVALID" });
	await assert.rejects(sharedService.search({ store: "notes", query: " ", mode: "hybrid" }), { code: "BACKEND_OUTPUT_INVALID" });
	await privateService.shutdown();
	await sharedService.shutdown();
	await rm(root, { recursive: true, force: true });
});

test("concurrent calls wait for one completed attachment", async (t) => {
	const socketDir = `/tmp/dsh${process.pid}`;
	await mkdir(socketDir, { mode: 0o700 });
	await chmod(socketDir, 0o700);
	const socketPath = join(socketDir, "s.sock");
	const seen: string[] = [];
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	let helloSeen!: () => void;
	const sawHello = new Promise<void>((resolve) => { helloSeen = resolve; });
	const generation = `gen-${"b".repeat(32)}`;
	let server: Server | undefined;
	let client: SharedIndexClient | undefined;
	const sockets = new Set<Socket>();
	t.after(async () => {
		release();
		await client?.shutdown();
		for (const socket of sockets) socket.destroy();
		const currentServer = server;
		if (currentServer) await new Promise<void>((resolve) => currentServer.close(() => resolve()));
		await rm(socketDir, { recursive: true, force: true });
	});
	server = await listenOwnedSocket(socketPath, (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		attachSharedParser(socket, (message: any) => {
			seen.push(message.operation);
			if (message.operation === "hello") { helloSeen(); void held.then(() => socket.write(encodeSharedMessage({ version: 1, requestId: message.requestId, generation, definitionRevision: "c".repeat(64), ok: true, result: { generation, version: "fixture" } }))); }
			if (message.operation === "activity") socket.write(encodeSharedMessage({ version: 1, requestId: message.requestId, generation, definitionRevision: "c".repeat(64), ok: true, result: { state: "idle", active: false, queued: false, embeddingActive: false, jobs: [] } }));
		}, () => socket.destroy());
	});
	client = new SharedIndexClient({ socketPath, store: "notebook", definitionRevision: "c".repeat(64) });
	const first = client.activity();
	await sawHello;
	const second = client.activity();
	await Promise.resolve();
	assert.deepEqual(seen, ["hello"]);
	release();
	assert.equal((await first).state, "idle");
	assert.equal((await second).state, "idle");
	assert.deepEqual(seen, ["hello", "activity", "activity"]);
});
