import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { MetadataIndex, registerMetadata } from "../src/metadata-index.ts";

test("a path update does not reopen an unreadable unrelated note", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "incremental-")));
	const notes = join(root, "notes");
	const state = join(root, "state");
	await mkdir(notes, { recursive: true });
	await writeFile(join(notes, "alpha.md"), "[[beta]]\n");
	await writeFile(join(notes, "beta.md"), "hello\n");
	const configDir = join(root, ".pi", "markdown-datastore");
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	await chmod(join(root, ".pi"), 0o755);
	await chmod(configDir, 0o700);
	const configPath = join(configDir, "config.json");
	await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notes: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } } } }), { mode: 0o600 });
	const config = await loadMarkdownDatastoreConfig(root, configPath);
	const store = config.stores.get("notes")!;
	const index = new MetadataIndex(state);
	await index.refresh(store);
	await chmod(join(notes, "beta.md"), 0);
	await writeFile(join(notes, "alpha.md"), "[[beta]] edited\n");
	const updated = await index.updatePaths(store, ["alpha.md"]);
	assert.equal(updated.files["alpha.md"]?.kind, "note");
	assert.equal(updated.files["beta.md"]?.kind, "note");
	await chmod(join(notes, "beta.md"), 0o600);
});

test("the reconciliation timer is the accepted five minutes", () => {
	const coordinator = new MaintenanceCoordinator(join(tmpdir(), "unused-jobs.json"), () => new Set());
	let delay = 0;
	coordinator.startCycle(async () => undefined, undefined, ((run: () => void, ms: number) => { delay = ms; return { unref() {}, ref() {} } as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout);
	assert.equal(delay, 300_000);
	void coordinator;
});
