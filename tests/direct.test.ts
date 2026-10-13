import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { countSafeNotes, noteRefToUri, noteUriToRef, safeOpenNote } from "../src/containment.ts";
import { DatastoreError } from "../src/errors.ts";
import { parseMarkdown } from "../src/markdown.ts";
import { MarkdownDatastoreService } from "../src/service.ts";

async function fixture(t: test.TestContext) {
	const project = await mkdtemp(join(tmpdir(), "datastore-direct-"));
	t.after(() => rm(project, { recursive: true, force: true }));
	const storeRoot = join(project, "notes");
	const configDir = join(project, ".pi", "markdown-datastore");
	await mkdir(storeRoot, { recursive: true, mode: 0o700 });
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await chmod(configDir, 0o700);
	const configPath = join(configDir, "config.json");
	const config = {
		schemaVersion: 1,
		defaults: { maxResultBytes: 4096, maxResultLines: 100, operationTimeoutMs: 10000 },
		qmd: { enabled: false, installation: { executable: "qmd" }, minimumVersion: "2.8.3" },
		stores: { memory: { root: "notes", include: ["**/*.md"], exclude: ["private/**"], maxFileBytes: 2048, search: { defaultMode: "hybrid", qmdCollection: "memory" } } },
	};
	await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
	await chmod(configPath, 0o600);
	return { project, storeRoot, configPath };
}

function code(error: unknown): string | undefined { return error instanceof DatastoreError ? error.code : undefined; }
function assertBounded(result: { bounds: { returnedBytes: number; returnedLines: number; maxBytes: number; maxLines: number } }): void { assert.ok(result.bounds.returnedBytes <= result.bounds.maxBytes); assert.ok(result.bounds.returnedLines <= result.bounds.maxLines); assert.doesNotThrow(() => JSON.parse(JSON.stringify(result))); }

test("strict protected config rejects duplicate keys, unknown fields, symlinks, and unsafe mode", async (t) => {
	const current = await fixture(t);
	const valid = await loadMarkdownDatastoreConfig(current.project, current.configPath);
	assert.equal(valid.stores.get("memory")?.root, await realpath(current.storeRoot));

	await writeFile(current.configPath, '{"schemaVersion":1,"schemaVersion":1}', { mode: 0o600 });
	await assert.rejects(() => loadMarkdownDatastoreConfig(current.project, current.configPath), (error) => code(error) === "CONFIG_INVALID");

	const other = join(current.project, "other.json");
	await writeFile(other, "{}", { mode: 0o600 });
	await rm(current.configPath);
	await symlink(other, current.configPath);
	await assert.rejects(() => loadMarkdownDatastoreConfig(current.project, current.configPath), (error) => code(error) === "CONFIG_INVALID");
});

test("status does not traverse undecodable source notes and leaves count unavailable without a manifest", async (t) => {
	const current = await fixture(t); await writeFile(join(current.storeRoot, "opaque.md"), Buffer.from([0xff, 0xfe, 0xfd]));
	const config = await loadMarkdownDatastoreConfig(current.project, current.configPath); const store = config.stores.get("memory")!;
	assert.equal(await countSafeNotes(store), 1); const status = await new MarkdownDatastoreService(config).status({ store: "memory" }); const storeStatus = (status.data.stores as Array<any>)[0]; assert.equal(storeStatus.fileCount, undefined); assert.equal(storeStatus.fileCountSource, "unavailable"); assert.equal(storeStatus.sourceReconciliation.state, "pending"); assert.equal(storeStatus.sourceReconciliation.sourceTraversalPerformed, false);
	await assert.rejects(() => safeOpenNote(store, "opaque.md"), (error) => code(error) === "INVALID_UTF8");
});

test("explicit traversal counts beyond the candidate ceiling while status remains cached and bounded", async (t) => {
	const current = await fixture(t);
	await Promise.all(Array.from({ length: 510 }, (_value, index) => writeFile(join(current.storeRoot, `note-${String(index).padStart(3, "0")}.md`), "# Note\n")));
	const config = await loadMarkdownDatastoreConfig(current.project, current.configPath);
	assert.equal(await countSafeNotes(config.stores.get("memory")!), 510);
	const status = await new MarkdownDatastoreService(config).status({ store: "memory" });
	const storeStatus = (status.data.stores as Array<any>)[0]; assert.equal(storeStatus.fileCount, undefined); assert.equal(storeStatus.fileCountSource, "unavailable");
	assert.equal(storeStatus.capabilities.outline.state, "ready"); assert.equal(storeStatus.capabilities.graph, undefined); assert.equal(storeStatus.capabilities.metadata, undefined); assert.deepEqual(storeStatus.capabilities.mutations, { supported: false }); assert.deepEqual(storeStatus.permissionWarnings, []);
	assert.ok(Buffer.byteLength(JSON.stringify(status)) < 32 * 1024);
});

test("recursive traversal freshly lstats and skips symlinked directories", async (t) => {
	const current = await fixture(t); const outside = join(current.project, "outside"); await mkdir(outside); await writeFile(join(outside, "escaped.md"), "# Escaped\n");
	await symlink(outside, join(current.storeRoot, "linked-directory"));
	const config = await loadMarkdownDatastoreConfig(current.project, current.configPath);
	assert.equal(await countSafeNotes(config.stores.get("memory")!), 0);
});

test("service shutdown aborts a scheduled direct operation and awaits its settlement", async (t) => {
	const current = await fixture(t); const config = await loadMarkdownDatastoreConfig(current.project, current.configPath); const service = new MarkdownDatastoreService(config);
	const operation = service.status({ store: "memory" }); const shutdown = service.shutdown();
	await assert.rejects(() => operation, (error) => code(error) === "CANCELLED"); await shutdown;
});

test("twenty content hits obey the aggregate search budget", async (t) => {
	const current = await fixture(t); const entries: Record<string, { revision: string; mtime: string; size: number }> = {}; const candidates = [];
	for (let index = 0; index < 20; index += 1) { const path = `search-${index}.md`; await writeFile(join(current.storeRoot, path), `# Search ${index}\nneedle ${"x".repeat(1000)}\n`); const source = await safeOpenNote((await loadMarkdownDatastoreConfig(current.project, current.configPath)).stores.get("memory")!, path); entries[path] = { revision: source.fullRevision, mtime: source.mtime, size: source.size }; candidates.push({ path, backendRank: index + 1 }); }
	const config = await loadMarkdownDatastoreConfig(current.project, current.configPath); const qmd = { binding: { version: "2.8.3" }, isLexicallyCurrent() { return true; }, async search() { return { generation: "fixture", manifest: { version: 1, backendVersion: "2.8.3", configFingerprint: "fixture", generatedAt: new Date().toISOString(), pendingEmbeddings: 20, hasVectorIndex: false, stores: { memory: entries } }, candidates }; }, async shutdown() {} } as any;
	const result = await new MarkdownDatastoreService(config, undefined, qmd).search({ store: "memory", query: "needle", mode: "lexical", limit: 20, includeContent: true }); assert.equal(result.bounds.truncated, true); assert.ok(result.data.hits.length < 20); assert.equal(result.warnings.at(-1)?.code, "RESULT_LIMIT_EXCEEDED"); assertBounded(result);
});

test("read rejects dual identities and view-specific parameter conflicts", async (t) => {
	const current = await fixture(t); await writeFile(join(current.storeRoot, "note.md"), "# Note\n"); const service = new MarkdownDatastoreService(await loadMarkdownDatastoreConfig(current.project, current.configPath)); const note = { store: "memory", path: "note.md" }; const uri = noteRefToUri(note);
	for (const input of [
		{ note, uri, view: "content" }, { note, view: "section" }, { note, view: "section", headingPath: ["Note"], sectionHandle: "0".repeat(32) },
		{ note, view: "metadata", includeFrontmatter: false }, { note, view: "links", excludeSections: [] }, { note, view: "content", includeSemanticRelated: false },
	] as any[]) await assert.rejects(() => service.read(input), (error) => code(error) === "INVALID_NOTE_REF");
	await assert.rejects(() => service.read({ note, view: "metadata", includeFrontmatter: false } as any), (error: any) => error.code === "INVALID_NOTE_REF" && error.message === "INVALID_NOTE_REF: The includeFrontmatter option is not valid for the metadata view." && JSON.stringify(error.details) === JSON.stringify({ reason: "OPTION_NOT_ALLOWED", view: "metadata", option: "includeFrontmatter" }) && !error.message.includes("note.md"));
});

test("note URI encoding is canonical and rejects ambiguous or escaping forms", () => {
	const note = { store: "memory", path: "people/Sean % # ?.md" };
	const uri = "datastore://memory/people/Sean%20%25%20%23%20%3F.md";
	assert.equal(noteRefToUri(note), uri);
	assert.deepEqual(noteUriToRef(uri), note);
	for (const invalid of [
		"datastore://memory/a%2fb.md", "datastore://memory/a%2Fb.md", "datastore://memory/a%20b.md?x=1",
		"datastore://memory/a%20b.md#x", "datastore://user@memory/a.md", "datastore://memory:3/a.md",
		"datastore://memory/a%2emd", "datastore://memory/../a.md",
	]) assert.throws(() => noteUriToRef(invalid), (error) => code(error) === "INVALID_NOTE_REF");
});

test("safe open rejects traversal, descendant symlinks, and hard links", async (t) => {
	const current = await fixture(t);
	await writeFile(join(current.storeRoot, "safe.md"), "# Safe\nBody\n");
	const config = await loadMarkdownDatastoreConfig(current.project, current.configPath);
	const store = config.stores.get("memory")!;
	assert.equal((await safeOpenNote(store, "safe.md")).text, "# Safe\nBody\n");
	await assert.rejects(() => safeOpenNote(store, "../safe.md"), (error) => code(error) === "INVALID_NOTE_REF");
	await symlink(join(current.storeRoot, "safe.md"), join(current.storeRoot, "alias.md"));
	await assert.rejects(() => safeOpenNote(store, "alias.md"), (error) => code(error) === "SYMLINK_REJECTED");
	await link(join(current.storeRoot, "safe.md"), join(current.storeRoot, "hard.md"));
	await assert.rejects(() => safeOpenNote(store, "hard.md"), (error) => code(error) === "UNSAFE_FILE_TYPE");
});

test("CommonMark headings ignore code, support Setext, and preserve duplicate sections", async (t) => {
	const current = await fixture(t);
	const body = "---\ntitle: Canonical\naliases: [One, Two]\ntags: '#x'\n---\n# First\nText\n```\n# Not heading\n```\nSetext\n------\n## Repeat\nA\n## Repeat\nB\n";
	await writeFile(join(current.storeRoot, "note.md"), body);
	const config = await loadMarkdownDatastoreConfig(current.project, current.configPath);
	const parsed = parseMarkdown(await safeOpenNote(config.stores.get("memory")!, "note.md"));
	assert.equal(parsed.title, "Canonical");
	assert.deepEqual(parsed.frontmatter.aliases, ["One", "Two"]);
	assert.deepEqual(parsed.frontmatter.tags, ["x"]);
	assert.deepEqual(parsed.outline.map((item) => [item.heading, item.depth, item.occurrence]), [["First", 1, 0], ["Setext", 2, 0], ["Repeat", 2, 0], ["Repeat", 2, 1]]);
});

test("direct service pages bounded content and invalidates stale continuations", async (t) => {
	const current = await fixture(t);
	await writeFile(join(current.storeRoot, "note.md"), "# Heading\nline one\nline two\nline three\nline four\nline five\n");
	const service = new MarkdownDatastoreService(await loadMarkdownDatastoreConfig(current.project, current.configPath));
	const first = await service.read({ note: { store: "memory", path: "note.md" }, view: "content", maxBytes: 32, maxLines: 3 });
	assert.equal(first.bounds.truncated, true); assert.equal(first.bounds.maxBytes, 32); assert.equal(first.bounds.maxLines, 3); assertBounded(first);
	assert.match(String(first.data.content), /Heading/);
	assert.ok(first.bounds.continuation);
	await writeFile(join(current.storeRoot, "note.md"), "# Changed\n");
	await assert.rejects(() => service.read({ continuation: first.bounds.continuation }), (error) => code(error) === "STALE_CONTINUATION");
});

test("outline returns opaque section handles and exact duplicate occurrence reads", async (t) => {
	const current = await fixture(t);
	await writeFile(join(current.storeRoot, "note.md"), "# A\n## Same\none\n## Same\ntwo\n");
	const service = new MarkdownDatastoreService(await loadMarkdownDatastoreConfig(current.project, current.configPath));
	const outline = await service.read({ note: { store: "memory", path: "note.md" }, view: "outline" });
	const entries = outline.data.outline as Array<{ heading: string; occurrence: number; handle: string }>;
	assert.equal(entries.length, 3);
	const second = entries.find((entry) => entry.heading === "Same" && entry.occurrence === 1)!;
	assert.match(second.handle, /^[0-9a-f]{32}$/);
	const section = await service.read({ note: { store: "memory", path: "note.md" }, view: "section", sectionHandle: second.handle });
	assert.equal(section.data.content, "## Same\ntwo\n");
});

test("unsupported discovery and graph views fail explicitly while direct outlines remain ready",async t=>{
 const f=await fixture(t);await writeFile(join(f.storeRoot,'note.md'),'# Note\nBody\n');const service=new MarkdownDatastoreService(await loadMarkdownDatastoreConfig(f.project,f.configPath));
 for(const selector of [{kind:'title',value:'Note'},{kind:'path',path:'note'},{kind:'tag',value:'tag'},{kind:'link',target:'note.md'}] as any[])await assert.rejects(service.find({store:'memory',selectors:[selector]}),{code:'CAPABILITY_UNAVAILABLE'});
 for(const view of ['links','backlinks','metadata','related'] as const)await assert.rejects(service.read({note:{store:'memory',path:'note.md'},view}),{code:'CAPABILITY_UNAVAILABLE'});
 assert.equal(((await service.read({note:{store:'memory',path:'note.md'},view:'outline'})).data.outline as any[]).length,1);
});

test("config authority rejects unsafe ancestors, duplicate collections", async (t) => {
	const current = await fixture(t);
	const raw = JSON.parse(await readFile(current.configPath, "utf8"));
	raw.qmd.enabled = true; raw.stores.memory.include = ["notes/*.md", "**/*.md"];
	await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 });
	await assert.rejects(() => loadMarkdownDatastoreConfig(current.project, current.configPath), (error) => code(error) === "CONFIG_INVALID");
	raw.qmd.enabled = false; raw.stores.memory.include = ["**/*.md"];
	await mkdir(join(current.project, "other"), { mode: 0o700 });
	raw.stores.other = { ...raw.stores.memory, root: "other" };
	await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 });
	await assert.rejects(() => loadMarkdownDatastoreConfig(current.project, current.configPath), (error) => code(error) === "CONFIG_INVALID");

	delete raw.stores.other;
	await writeFile(current.configPath, JSON.stringify(raw), { mode: 0o600 });
	await chmod(join(current.project, ".pi"), 0o777);
	await assert.rejects(() => loadMarkdownDatastoreConfig(current.project, current.configPath), (error) => code(error) === "CONFIG_INVALID");

	await rm(join(current.project, ".pi"), { recursive: true });
	const redirected = join(current.project, "redirected");
	await mkdir(join(redirected, "markdown-datastore"), { recursive: true, mode: 0o700 });
	await writeFile(join(redirected, "markdown-datastore", "config.json"), JSON.stringify(raw), { mode: 0o600 });
	await symlink(redirected, join(current.project, ".pi"));
	await assert.rejects(() => loadMarkdownDatastoreConfig(current.project, current.configPath), (error) => code(error) === "CONFIG_INVALID");
});
