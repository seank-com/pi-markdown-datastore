import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { MaintenanceCoordinator } from "../src/maintenance-coordinator.ts";
import { MetadataIndex, reconcileChanged, registerMetadata } from "../src/metadata-index.ts";
import type { StoreConfig } from "../src/config.ts";

async function fixture(t: TestContext): Promise<{ root: string; notes: string; state: string; store: StoreConfig }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "incremental-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const notes = join(root, "notes");
	const state = join(root, "state");
	await mkdir(notes, { recursive: true });
	await mkdir(state, { recursive: true, mode: 0o700 });
	const configDir = join(root, ".pi", "markdown-datastore");
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await chmod(root, 0o700);
	await chmod(join(root, ".pi"), 0o755);
	await chmod(configDir, 0o700);
	const configPath = join(configDir, "config.json");
	await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notes: { root: notes, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } } } }), { mode: 0o600 });
	const config = await loadMarkdownDatastoreConfig(root, configPath);
	return { root, notes, state, configPath: configPath, store: config.stores.get("notes")! };
}

function semantic(snapshot: { files: Record<string, { kind: string; links?: unknown; tags?: string[]; size?: number; mtime?: string }>; targets: Record<string, string[]>; tags: Record<string, string[]>; references: Record<string, string[]>; complete: boolean; diagnostics: string[] }) {
	return { files: snapshot.files, targets: snapshot.targets, tags: snapshot.tags, references: snapshot.references, complete: snapshot.complete, diagnostics: snapshot.diagnostics };
}

test("path updates keep written targets and match a rebuild", async (t) => {
	const { notes, state, store } = await fixture(t);
	await mkdir(join(notes, "clients"));
	await writeFile(join(notes, "clients", "Project Atlas.md"), "---\ntags: ['#Projects']\n---\n[[Missing Project]]\n");
	await writeFile(join(notes, "constructor.md"), "[[constructor]]\n");
	const index = new MetadataIndex(state);
	const first = await index.refresh(store);
	assert.equal(first.files["clients/Project Atlas.md"].links?.[0].target, "Missing Project");
	assert.deepEqual(first.targets["Missing Project"], []);
	assert.equal(Object.hasOwn(first.files, "constructor.md"), true);
	assert.match(await readFile(join(state, "index.json"), "utf8"), /"constructor.md"/);

	await chmod(join(notes, "constructor.md"), 0);
	await writeFile(join(notes, "clients", "Project Atlas.md"), "---\ntags: ['#Projects']\n---\n[[Missing Project]]\nedited\n");
	const edited = await index.updatePaths(store, ["clients/Project Atlas.md"]);
	assert.equal(edited.files["constructor.md"].revision, first.files["constructor.md"].revision);
	await chmod(join(notes, "constructor.md"), 0o600);

	const kept = edited.files["clients/Project Atlas.md"].links;
	await utimes(join(notes, "clients", "Project Atlas.md"), new Date(), new Date());
	const stamped = await index.updatePaths(store, ["clients/Project Atlas.md"]);
	assert.equal(stamped.files["clients/Project Atlas.md"].links, kept);
	assert.notEqual(stamped.files["clients/Project Atlas.md"].mtime, edited.files["clients/Project Atlas.md"].mtime);

	await writeFile(join(notes, "clients", "Other Atlas.md"), "same stem\n");
	await index.updatePaths(store, ["clients/Other Atlas.md"]);
	assert.equal((await index.links("clients/Project Atlas.md"))[0].targetKind, "unresolved");
	await writeFile(join(notes, "Missing Project.md"), "now here\n");
	await index.updatePaths(store, ["Missing Project.md"]);
	assert.equal((await index.links("clients/Project Atlas.md"))[0].targetKind, "note");
	await writeFile(join(notes, "also", "Missing Project.md"), "collision\n").catch(async () => { await mkdir(join(notes, "also")); await writeFile(join(notes, "also", "Missing Project.md"), "collision\n"); });
	await index.updatePaths(store, ["also/Missing Project.md"]);
	assert.equal((await index.links("clients/Project Atlas.md"))[0].targetKind, "ambiguous");

	await rm(join(notes, "clients", "Project Atlas.md"));
	await rename(join(notes, "constructor.md"), join(notes, "renamed.md"));
	await index.updatePaths(store, ["clients/Project Atlas.md", "constructor.md", "renamed.md"]);
	assert.equal(Object.hasOwn((await index.snapshot())!.files, "clients/Project Atlas.md"), false);
	assert.equal(Object.hasOwn((await index.snapshot())!.files, "renamed.md"), true);

	const incremental = semantic((await index.snapshot())!);
	const rebuilt = semantic(await new MetadataIndex(join(state, "rebuild")).rebuild(store));
	assert.deepEqual(incremental, rebuilt);
});

test("resolution covers explicit paths, attachments, self-fragments, tags, and reconcile", async (t) => {
	const { notes, state, store } = await fixture(t);
	await mkdir(join(notes, "clients"));
	await writeFile(join(notes, "clients", "Project Atlas.md"), "[[#Here]]\n");
	await writeFile(join(notes, "planner.md"), "[[clients/Project Atlas]]\n[[clients/Project Atlas.md]]\n[[diagram]]\n[[diagram.png]]\n[[folder\\page]]\n");
	await writeFile(join(notes, "diagram.png"), "png");
	await writeFile(join(notes, "diagram.svg"), "svg");
	await writeFile(join(notes, "__proto__.md"), "---\ntags: ['#Projects', 'active']\n---\nowned\n");
	const index = new MetadataIndex(state);
	await index.refresh(store);
	const planner = await index.links("planner.md");
	assert.deepEqual(planner.map((edge) => edge.targetKind), ["note", "note", "ambiguous", "attachment", "unresolved"]);
	assert.equal((await index.backlinks("clients/Project Atlas.md")).some((edge) => edge.source === "clients/Project Atlas.md" && edge.fragment === "Here"), true);
	assert.equal((await index.backlinks("planner.md")).some((edge) => edge.fragment === "Here"), false);
	const catalog = await index.catalog();
	assert.equal(catalog.find((tag) => tag.identity === "projects")?.spelling, "#Projects");
	assert.equal(Object.hasOwn((await index.snapshot())!.files, "__proto__.md"), true);
	await writeFile(join(notes, "broken.md"), "---\ntags: [\n");
	await index.updatePaths(store, ["broken.md"]);
	await writeFile(join(notes, "planner.md"), "[[clients/Project Atlas]]\n");
	const after = await index.updatePaths(store, ["planner.md"]);
	assert.equal(after.diagnostics.some((line) => line.startsWith("broken.md:")), true);
	await writeFile(join(notes, "external.md"), "added outside\n");
	const reconciled = await index.reconcile(store);
	assert.equal(Object.hasOwn(reconciled.files, "external.md"), true);
	const rebuilt = await new MetadataIndex(join(state, "oracle")).rebuild(store);
	assert.deepEqual(semantic(reconciled), semantic(rebuilt));
});

test("a failed snapshot write keeps the previous memory and disk", async (t) => {
	const { notes, state, store } = await fixture(t);
	await writeFile(join(notes, "alpha.md"), "one\n");
	const index = new MetadataIndex(state);
	const saved = await index.refresh(store);
	await chmod(state, 0o500);
	await writeFile(join(notes, "alpha.md"), "two\n");
	await assert.rejects(index.updatePaths(store, ["alpha.md"]));
	await chmod(state, 0o700);
	assert.equal((await index.snapshot())?.revision, saved.revision);
	assert.equal(JSON.parse(await readFile(join(state, "index.json"), "utf8")).revision, saved.revision);
});

test("demonstrated partial, diagnostic, dotted, ambiguous, and rebound cases stay honest", async (t) => {
	const { notes, state, store, root } = await fixture(t);
	await mkdir(join(notes, "other"));
	await writeFile(join(notes, "bad.md"), "---\ntags: [\n---\nbody\n");
	await writeFile(join(notes, "Project.v2.md"), "target\n");
	await writeFile(join(notes, "ref.md"), "[[Project.v2]]\n");
	await writeFile(join(notes, "Atlas.md"), "[[#Self]]\n[[Atlas.md]]\n");
	await writeFile(join(notes, "other", "Atlas.md"), "other\n");
	const partial = new MetadataIndex(join(root, "partial"));
	const one = await partial.updatePaths(store, ["ref.md"]);
	assert.equal(one.complete, false);
	assert.equal(Object.hasOwn(one.files, "bad.md"), true);
	const index = new MetadataIndex(state);
	const before = await index.rebuild(store);
	assert.equal((await index.links("ref.md"))[0].target, "Project.v2.md");
	assert.equal((await index.backlinks("Atlas.md")).some((edge) => edge.targetKind === "ambiguous"), false);
	await utimes(join(notes, "bad.md"), new Date(), new Date(Date.now() + 2000));
	const after = await index.updatePaths(store, ["bad.md"]);
	assert.equal(after.complete, before.complete);
	assert.deepEqual(after.diagnostics, before.diagnostics);
	const replacement = join(root, "replacement");
	await mkdir(replacement, { mode: 0o700 });
	await writeFile(join(replacement, "new.md"), "only\n");
	await writeFile(join(root, ".pi", "markdown-datastore", "config.json"), JSON.stringify({ schemaVersion: 1, defaults: { maxResultBytes: 8192, maxResultLines: 100, operationTimeoutMs: 3000 }, qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" }, stores: { notes: { root: replacement, include: ["**/*.md"], exclude: [], maxFileBytes: 4096, search: { defaultMode: "lexical", qmdCollection: "notes" } } } }), { mode: 0o600 });
	const reboundStore = (await loadMarkdownDatastoreConfig(root, join(root, ".pi", "markdown-datastore", "config.json"))).stores.get("notes")!;
	const rebound = await index.updatePaths(reboundStore, ["new.md"]);
	assert.deepEqual(Object.keys(rebound.files).sort(), ["new.md"]);
	assert.equal(rebound.root, replacement);
});

test("deleting the last candidate keeps a referenced empty target", async (t) => {
	const { notes, state, store } = await fixture(t);
	await writeFile(join(notes, "Destination.md"), "here\n");
	await writeFile(join(notes, "Ref2.md"), "[[Destination]]\n");
	const index = new MetadataIndex(state);
	await index.rebuild(store);
	await rm(join(notes, "Destination.md"));
	const updated = await index.updatePaths(store, ["Destination.md"]);
	assert.deepEqual(updated.targets.Destination, []);
	const rebuilt = await new MetadataIndex(join(state, "oracle")).rebuild(store);
	assert.deepEqual(updated.targets.Destination, rebuilt.targets.Destination);
});

test("a generated mutation sequence matches rebuild without reopening untouched notes", async (t) => {
	const { notes, state, store } = await fixture(t);
	for (let index = 0; index < 4; index += 1) await writeFile(join(notes, `n${index}.md`), index === 0 ? "[[n1]]\n" : `body ${index}\n`);
	const index = new MetadataIndex(state);
	await index.rebuild(store);
	await chmod(join(notes, "n2.md"), 0);
	await chmod(join(notes, "n3.md"), 0);
	await writeFile(join(notes, "n0.md"), "[[n1]] changed\n");
	await rm(join(notes, "n1.md"));
	const updated = await index.updatePaths(store, ["n0.md", "n1.md"]);
	await chmod(join(notes, "n2.md"), 0o600);
	await chmod(join(notes, "n3.md"), 0o600);
	const rebuilt = await new MetadataIndex(join(state, "oracle")).rebuild(store);
	assert.deepEqual(semantic(updated), semantic(rebuilt));
	assert.equal(Object.hasOwn(updated.files, "n2.md"), true);
});

test("a fake clock runs graph reconciliation before lexical work", async (t) => {
	const { notes, state, store } = await fixture(t);
	await writeFile(join(notes, "a.md"), "one\n");
	const index = new MetadataIndex(state);
	await index.refresh(store);
	await writeFile(join(notes, "a.md"), "two\n");
	await utimes(join(notes, "a.md"), new Date(), new Date(Date.now() + 2000));
	const coordinator = new MaintenanceCoordinator(join(state, "jobs.json"), () => new Set(["notes"]));
	registerMetadata(coordinator, new Map([["notes", index]]), new Map([["notes", store]]));
	const order: string[] = [];
	coordinator.register("lexical", async () => { order.push("lexical"); });
	let armed = 0;
	coordinator.startCycle(async () => { order.push("cycle"); }, undefined, ((callback: () => void) => {
		if (armed++ === 0) callback();
		return { unref() {}, ref() {} } as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout);
	assert.equal(order[0], "cycle");
	await reconcileChanged(coordinator, new Map([["notes", index]]), new Map([["notes", store]]));
	const lexical = coordinator.jobs().find((job) => job.mode === "lexical");
	assert.ok(lexical);
	await coordinator.persisted(lexical.refreshId);
	assert.equal(coordinator.jobs().find((job) => job.refreshId === lexical.refreshId)?.state, "succeeded");
});

test("the reconciliation timer is the accepted five minutes", () => {
	const coordinator = new MaintenanceCoordinator(join(tmpdir(), "unused-jobs.json"), () => new Set());
	let delay = 0;
	coordinator.startCycle(async () => undefined, undefined, ((_: () => void, ms: number) => { delay = ms; return { unref() {}, ref() {} } as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout);
	assert.equal(delay, 300_000);
});
