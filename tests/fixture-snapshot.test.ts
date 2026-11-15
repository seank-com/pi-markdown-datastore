import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createQmdFixture } from "./fixtures/qmd-fixture.ts";

test("synthetic SDK publishes whole snapshots without truncating an independent reader", async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "qmd-fixture-snapshot-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notes = join(root, "notes"); await mkdir(notes);
	await writeFile(join(notes, "one.md"), "first complete revision\n");
	const packageRoot = await createQmdFixture(root), dbPath = join(root, "fixture.json");
	const { createStore } = await import(pathToFileURL(join(packageRoot, "sdk.mjs")).href);
	const store = await createStore({ dbPath, config: { collections: { notes: { path: notes } } } });
	try {
		await store.update({ collections: ["notes"] });
		const previous = await open(dbPath, "r");
		try {
			await writeFile(join(notes, "one.md"), "second complete revision\n");
			await store.update({ collections: ["notes"] });
			const snapshot = JSON.parse(await previous.readFile("utf8"));
			assert.equal(snapshot.collections.notes[0].text, "first complete revision\n");
			assert.equal(await store.getDocumentBody("qmd://notes/one.md"), "second complete revision\n");
		} finally { await previous.close(); }
	} finally { await store.close(); }
});
