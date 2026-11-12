import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { MetadataIndex, registerMetadata } from "../src/metadata-index.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { startSharedHost } from "../src/shared-host.ts";
import { SharedIndexClient } from "../src/shared-client.ts";

async function projectConfig(root: string, stores: Record<string, string>) {
	const dir = join(root, ".pi", "markdown-datastore");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const body: Record<string, unknown> = {};
	for (const [name, path] of Object.entries(stores)) {
		await mkdir(path, { recursive: true });
		body[name] = { root: path, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: name } };
	}
	const configPath = join(dir, "config.json");
	await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: body }), { mode: 0o600 });
	return loadMarkdownDatastoreConfig(root, configPath);
}

test("two stores keep separate metadata snapshots after reopen", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-iso-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notes = join(root, "notes");
	const archive = join(root, "archive");
	await mkdir(notes); await mkdir(archive);
	await writeFile(join(notes, "alpha.md"), "See [[beta]].\n");
	await writeFile(join(notes, "beta.md"), "Note.\n");
	await writeFile(join(archive, "only.md"), "Archive.\n");
	const config = await projectConfig(root, { notes, archive });
	const indexes = new Map([["notes", new MetadataIndex(join(root, "state", "metadata-notes"))], ["archive", new MetadataIndex(join(root, "state", "metadata-archive"))]]);
	const coordinator = new MaintenanceCoordinator(join(root, "state", "jobs.json"), () => new Set(config.stores.keys()));
	registerMetadata(coordinator, indexes, config.stores);
	await coordinator.enqueue("metadata", ["notes", "archive"], "explicit-maintenance");
	await coordinator.settled();
	const reopened = new MetadataIndex(join(root, "state", "metadata-notes"));
	const links = await reopened.links("alpha.md");
	assert.equal(links[0]?.target, "beta.md");
	const archiveIndex = new MetadataIndex(join(root, "state", "metadata-archive"));
	assert.equal((await archiveIndex.links("alpha.md")).length, 0);
});

test("incomplete metadata is not reported current and tag find continues past twenty", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-page-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notes = join(root, "notes");
	await mkdir(notes, { recursive: true });
	await writeFile(join(notes, "bad.md"), "---\ntags: [Travel\n---\n[[missing]]\n");
	for (let index = 0; index < 21; index += 1) await writeFile(join(notes, `p${index}.md`), "---\ntags: travel\n---\nPage.\n");
	const config = await projectConfig(root, { notes });
	const indexes = new Map([["notes", new MetadataIndex(join(root, "state", "metadata-notes"))]]);
	const coordinator = new MaintenanceCoordinator(join(root, "state", "jobs.json"), () => new Set(["notes"]));
	registerMetadata(coordinator, indexes, config.stores);
	const service = new MarkdownDatastoreService(config);
	service.bindMetadata(coordinator, indexes);
	await service.refresh({ store: "notes", mode: "metadata" });
	await coordinator.settled();
	const links = await service.read({ store: "notes", note: { store: "notes", path: "bad.md" }, view: "links" });
	assert.equal(links.provenance.sources[0].freshness, "stale");
	const first = await service.find({ store: "notes", selectors: [{ kind: "tag", value: "travel" }], limit: 20 });
	assert.equal(first.data.candidates.length, 20);
	assert.equal(first.bounds.truncated, true);
	const second = await service.find({ store: "notes", selectors: [{ kind: "tag", value: "travel" }], limit: 20, continuation: first.bounds.continuation } as never);
	assert.equal(second.data.candidates.length, 1);
});

test("graph-only shared host refreshes metadata without qmd", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "datastore-shared-meta-")));
	const socketDir = `/tmp/dsm${process.pid}`;
	await mkdir(socketDir, { mode: 0o700 });
	await chmod(socketDir, 0o700);
	t.after(async () => { await rm(socketDir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
	const notes = join(root, "notes");
	await mkdir(notes, { recursive: true });
	await writeFile(join(notes, "alpha.md"), "See [[beta]].\n");
	await writeFile(join(notes, "beta.md"), "Target.\n");
	const state = join(root, "state");
	await mkdir(state, { mode: 0o700 });
	const catalogPath = join(root, "catalog.json");
	await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, socketPath: join(socketDir, "s.sock"), stateRoot: state, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notebook: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notebook" } } } }), { mode: 0o600 });
	const host = await startSharedHost(catalogPath);
	t.after(() => host.close());
	const catalog = await import("../src/shared-catalog.ts").then((mod) => mod.loadSharedCatalog(catalogPath));
	const defined = catalog.stores.get("notebook")!;
	const client = new SharedIndexClient({ socketPath: join(socketDir, "s.sock"), store: "notebook", definitionRevision: defined.definitionRevision });
	t.after(() => client.shutdown());
	const receipt = await client.startMetadata();
	assert.equal(receipt.coalesced, false);
	await host.coordinators.get("notebook")?.settled();
	const edges = await client.links("alpha.md") as { target?: string }[];
	assert.equal(edges[0]?.target, "beta.md");
});
