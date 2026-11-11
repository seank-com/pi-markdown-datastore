import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { discoverQmdBinding, QmdAdapter } from "../src/qmd-adapter.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
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
	const socketPath = `/tmp/ds-${process.pid}-${Date.now()}.sock`;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(socketPath, { force: true }));
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
	const privateAdapter = new QmdAdapter(privateConfig, await discoverQmdBinding(privateConfig));
	t.after(() => privateAdapter.shutdown());
	const first = await privateAdapter.startLexicalRefresh([privateConfig.stores.get("memory")!]);
	const second = await privateAdapter.startLexicalRefresh([privateConfig.stores.get("memory")!]);
	assert.equal(second.refreshId, first.refreshId);
	assert.equal(second.coalesced, true);

	const child = spawn(process.execPath, ["--experimental-strip-types", "src/shared-service-main.ts", "--catalog", catalogPath], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => { child.kill("SIGTERM"); });
	let err = "";
	child.stderr.on("data", (chunk) => { err += chunk; });
	const generation = await new Promise<string>((resolve, reject) => {
		let buf = "";
		child.stdout.on("data", (chunk) => { buf += chunk; if (buf.includes("\n")) resolve(buf.split("\n")[0]); });
		child.once("exit", (code) => reject(new Error(`service exited ${code}: ${err}`)));
	});
	assert.match(generation, /^gen-/);
	const project = async (name: string, alias: string) => {
		const dir = join(root, name);
		await owned(join(dir, ".pi", "markdown-datastore"));
		const configPath = join(dir, ".pi", "markdown-datastore", "config.json");
		await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { [alias]: { shared: { catalog: catalogPath, store: "notebook" } } } }), { mode: 0o600 });
		const config = await loadMarkdownDatastoreConfig(dir, configPath);
		const client = new SharedIndexClient(config.stores.get(alias)!.shared!);
		const service = new MarkdownDatastoreService(config, undefined, undefined, new Map([[alias, client]]));
		return { config, service, client, alias };
	};
	const left = await project("left", "notes-alias");
	const right = await project("right", "archive-alias");
	t.after(() => Promise.all([left.service.shutdown(), right.service.shutdown()]));
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
	t.after(() => after.shutdown());
	await assert.rejects(after.refresh({ action: "start", store: right.alias, mode: "lexical" }), { code: "STORE_UNAVAILABLE" });
	const direct = await after.read({ store: right.alias, note: { store: right.alias, path: "alpha.md" } });
	assert.match(direct.data.content, /Copper shared note/);
	const projectState = join(root, "right", ".pi", "markdown-datastore", "state");
	await assert.rejects(readFile(projectState));
});
