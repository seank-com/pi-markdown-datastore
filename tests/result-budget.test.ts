import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { resolveResultBudget } from "../src/config-common.ts";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { MetadataIndex, registerMetadata } from "../src/metadata-index.ts";
import { MarkdownDatastoreService } from "../src/service.ts";

test("omitted budgets are unbounded and explicit values are not clamped", () => {
	assert.deepEqual(resolveResultBudget(undefined, {}), { maxBytes: null, maxLines: null });
	assert.deepEqual(resolveResultBudget({ maxBytes: 40000, maxLines: 900 }, { maxBytes: 100, maxLines: 2 }), { maxBytes: 40000, maxLines: 900 });
	assert.throws(() => resolveResultBudget({ maxBytes: 0 }, {}), /RESULT_LIMIT_EXCEEDED/);
});

test("an oversized status scope is returned when no result budget is configured", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "budget-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notes = join(root, "notes");
	const configDir = join(root, ".pi", "markdown-datastore");
	await mkdir(notes);
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	await chmod(join(root, ".pi"), 0o755);
	await chmod(configDir, 0o700);
	await writeFile(join(notes, "a.md"), "one\n");
	const configPath = join(configDir, "config.json");
	await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notes: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } } } }), { mode: 0o600 });
	const config = await loadMarkdownDatastoreConfig(root, configPath);
	assert.equal(config.defaults.maxResultBytes, undefined);
	const coordinator = new MaintenanceCoordinator(join(root, "jobs.json"), () => new Set(["notes"]));
	const paths = Array.from({ length: 2000 }, (_, index) => `notes/oversized-scope-${index}.md`);
	coordinator.notePaths("notes", paths);
	await coordinator.enqueue("metadata", ["notes"], "explicit-maintenance");
	const indexes = new Map([["notes", new MetadataIndex(join(root, "index"))]]);
	registerMetadata(coordinator, indexes, config.stores);
	const service = new MarkdownDatastoreService(config);
	service.bindMetadata(coordinator, indexes);
	t.after(() => service.shutdown());
	const status = await service.status({ store: "notes" });
	assert.equal(status.bounds.maxBytes, null);
	assert.ok(Buffer.byteLength(JSON.stringify(status)) > 32 * 1024);
	await assert.rejects(service.status({ store: "notes", maxBytes: 100 } as never), (error: unknown) => (error as { code?: string }).code === "RESULT_LIMIT_EXCEEDED");
});
