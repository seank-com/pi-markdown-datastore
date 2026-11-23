import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { QmdAdapter } from "../src/qmd-adapter.ts";
import { MarkdownDatastoreService } from "../src/service.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
import { startSharedHost, type SharedHost } from "../src/shared-host.ts";
import { declarationId } from "../src/shared-registrations.ts";

async function fixture(t: TestContext, packageRoot?: string) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "ds-")));
	const environment = { HOME: base, ...(packageRoot ? {
		XDG_CACHE_HOME: join(base, "cache"), XDG_CONFIG_HOME: join(base, "config"), QMD_CONFIG_DIR: join(base, "config", "qmd"),
	} : {}) };
	const previous = Object.keys(environment).map(key => [key, process.env[key]] as const);
	Object.assign(process.env, environment);
	let host: SharedHost | undefined;
	const clients: SharedIndexClient[] = [];
	t.after(async () => {
		try {
			await Promise.all(clients.map(client => client.shutdown()));
			await host?.close();
			await rm(base, { recursive: true, force: true });
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
		}
	});
	const settings = join(base, ".pi", "markdown-datastore", "host.json");
	const snapshot = join(dirname(settings), "registrations.json");
	const stateRoot = join(base, "state");
	const socketPath = join(base, "run", "s");
	await mkdir(dirname(settings), { recursive: true, mode: 0o700 });
	await writeFile(settings, JSON.stringify({ schemaVersion: 1, socketPath, stateRoot,
		defaults: { operationTimeoutMs: 10000 }, qmd: { enabled: Boolean(packageRoot), installation: packageRoot ? { packageRoot } : { executable: "unused" }, minimumVersion: "2.8.3" },
		reader: { maxFileBytes: 1048576, defaultMode: "lexical" },
	}), { mode: 0o600 });
	const source = async (name: string) => { const root = join(base, name); await mkdir(root, { recursive: true }); await writeFile(join(root, "note.md"), "# Note\n"); return root; };
	const attach = async (project: string, alias: string, root: string, exclude?: string[], include?: string[]) => {
		const dir = join(base, project, ".pi", "markdown-datastore");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "config.json"), JSON.stringify({ schemaVersion: 1, stores: { [alias]: { shared: { root, include, exclude } } } }), { mode: 0o600 });
		const config = await loadMarkdownDatastoreConfig(join(base, project));
		const client = new SharedIndexClient(config.stores.get(alias)!.shared!);
		clients.push(client);
		return client;
	};
	return { base, settings, snapshot, stateRoot, socketPath, source, attach, start: async () => host = await startSharedHost(settings), stop: async () => { await host?.close(); host = undefined; } };
}

test("registration reconstructs with zero clients, then from any matching declaration after snapshot loss", async t => {
	const f = await fixture(t);
	const root = await f.source("notes");
	const other = await f.source("notes-other");
	const first = await f.attach("first", "notes", root + "/", ["a", "b", "b"]);
	const second = await f.attach("second", "other", root, ["a", "b", "b"], ["**/*.md"]);
	const host = await f.start();
	assert.equal(host.coordinators.size, 0);
	await assert.rejects(startSharedHost(f.settings), { code: "STORE_UNAVAILABLE" });
	await Promise.all([first.status(), second.status()]);
	assert.equal(host.coordinators.size, 1);
	assert.deepEqual(JSON.parse(await readFile(f.snapshot, "utf8")), { schemaVersion: 1, registrations: { [root]: { include: ["**/*.md"], exclude: ["a", "b", "b"] } } });
	const repeated = await f.attach("repeat", "note", root, ["a", "b", "b"]);
	const inode = (await stat(f.snapshot)).ino;
	await repeated.status();
	assert.equal((await stat(f.snapshot)).ino, inode);
	const mismatch = await f.attach("bad", "note", root, ["b", "a"], ["*.md"]);
	await assert.rejects(mismatch.status(), { code: "CONFIG_INVALID", details: { conflictingFields: ["include", "exclude"] } });
	await (await f.attach("third", "note", other)).status();
	await f.stop();
	await rename(join(f.base, "first"), join(f.base, "moved"));
	await rm(f.stateRoot, { recursive: true });
	const restored = await f.start();
	assert.deepEqual([...restored.coordinators.keys()].sort(), [declarationId(root), declarationId(other)].sort());
	await restored.coordinators.get(declarationId(root))!.settled();
	assert.equal(await readFile(join(root, "note.md"), "utf8"), "# Note\n");
	await f.stop();
	await rm(f.snapshot);
	await rm(f.stateRoot, { recursive: true });
	const empty = await f.start();
	assert.equal(empty.coordinators.size, 0);
	await second.status();
	assert.deepEqual([...empty.coordinators.keys()], [declarationId(root)]);
});

test("declaration direct find and read use local alias and host reader policy without a host", async t => {
	const f = await fixture(t);
	const root = await f.source("notes");
	const settings = JSON.parse(await readFile(f.settings, "utf8"));
	settings.reader.maxFileBytes = 16;
	await writeFile(f.settings, JSON.stringify(settings));
	await writeFile(join(root, "large.md"), "# Too large for host reader policy\n");
	await f.attach("first", "local", root, ["note.md"]);
	const service = new MarkdownDatastoreService(await loadMarkdownDatastoreConfig(join(f.base, "first")));
	t.after(() => service.shutdown());
	const note = { store: "local", path: "note.md" };
	const found = await service.find({ store: "local", selectors: [{ kind: "path", path: note.path }] });
	assert.deepEqual(found.data.candidates.map(match => match.note), [note]);
	const read = await service.read({ note, view: "content" });
	assert.deepEqual(read.data.note, note);
	assert.match(read.data.content!, /# Note/);
	await assert.rejects(service.read({ note: { ...note, path: "large.md" }, view: "content" }), { code: "FILE_TOO_LARGE" });
	await assert.rejects(stat(f.socketPath), { code: "ENOENT" });
	await assert.rejects(stat(f.snapshot), { code: "ENOENT" });
});

test("host reloads a generated registration snapshot larger than an authored config", async t => {
	const f = await fixture(t);
	await f.start();
	const exclude = ["x".repeat(24 * 1024)];
	const roots = [];
	for (const name of ["one", "two", "three"]) {
		const root = await f.source(name);
		roots.push(root);
		await (await f.attach(`project-${name}`, "local", root, exclude)).status();
	}
	assert.ok((await stat(f.snapshot)).size > 64 * 1024);
	await f.stop();
	const restored = await f.start();
	assert.deepEqual([...restored.coordinators.keys()].sort(), roots.map(declarationId).sort());
	for (const root of roots) assert.deepEqual(restored.state.stores.get(declarationId(root))?.exclude, exclude);
});

const nativePackage = process.env.DATASTORE_QMD_PACKAGE;
test("native lexical declaration host rebuilds from its snapshot before any client attaches", { skip: !nativePackage }, async t => {
	const f = await fixture(t, nativePackage);
	const root = await f.source("notes");
	await writeFile(join(root, "note.md"), "# Copper heron\n");
	await writeFile(join(root, "second.md"), "# Copper owl\n");
	await writeFile(join(root, "ignored.md"), "# Copper robin\n");
	await writeFile(join(root, "outside.txt"), "# Copper finch\n");
	const id = declarationId(root);
	const first = await f.attach("first", "original", root, ["ignored.md"]);
	const startup = QmdAdapter.prototype.startupReconcile;
	const receipts = new Map<QmdAdapter, ReturnType<typeof startup>>();
	t.mock.method(QmdAdapter.prototype, "startupReconcile", function (this: QmdAdapter, ...args: Parameters<typeof startup>) {
		const receipt = startup.apply(this, args);
		receipts.set(this, receipt);
		return receipt;
	});
	const waitForLexical = async (host: SharedHost) => {
		const adapter = host.adapters.get(id);
		assert.ok(adapter, "the public native adapter must be available");
		assert.equal(adapter.binding.version, "2.8.3");
		const startupReceipt = receipts.get(adapter);
		assert.ok(startupReceipt, "host must invoke startup reconciliation before it returns or accepts an attachment");
		const receipt = await startupReceipt;
		await host.coordinators.get(id)!.settled();
		const job = host.coordinators.get(id)!.get(String(receipt.refreshId));
		assert.equal(job?.state, "succeeded", JSON.stringify(job));
		assert.equal(job?.ownership, "startup-reconciliation");
		assert.equal(adapter.isLexicallyCurrent(id), true);
		assert.ok(host.coordinators.get(id)!.jobs().every(job => job.mode === "lexical"));
	};
	const search = async (client: SharedIndexClient) => (await client.search("copper", "lexical", 20, undefined)).candidates.map(hit => hit.path).sort();
	const original = await f.start();
	await first.status();
	await waitForLexical(original);
	assert.deepEqual(await search(first), ["note.md", "second.md"]);
	await f.stop();
	await rm(f.stateRoot, { recursive: true });
	const rebuilt = await f.start();
	await waitForLexical(rebuilt);
	const second = await f.attach("second", "different", root, ["ignored.md"]);
	assert.deepEqual(await search(second), ["note.md", "second.md"]);
	assert.equal(await readFile(join(root, "ignored.md"), "utf8"), "# Copper robin\n");
});

test("overlapping admissions serialize and failed publication leaves no partial store", async t => {
	const f = await fixture(t);
	const parent = await f.source("notes");
	const child = await f.source("notes/child");
	const sibling = await f.source("notes-other");
	const host = await f.start();
	const first = await f.attach("first", "notes", parent);
	await mkdir(f.snapshot);
	await assert.rejects(first.status(), { code: "STORE_UNAVAILABLE" });
	assert.equal(host.state.stores.size, 0);
	assert.equal(host.coordinators.size, 0);
	await rm(f.snapshot, { recursive: true });
	const second = await f.attach("second", "notes", child);
	const concurrent = await Promise.allSettled([first.status(), second.status()]);
	assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
	const rejection = concurrent.find(result => result.status === "rejected") as PromiseRejectedResult;
	assert.deepEqual(rejection.reason.details, { conflictingFields: ["root"] });
	assert.equal(host.coordinators.size, 1);
	await f.stop();
	await rm(f.snapshot);
	await f.start();
	await second.status();
	await assert.rejects(first.status(), { details: { conflictingFields: ["root"] } });
	await (await f.attach("third", "notes", sibling)).status();
	const alias = join(f.base, "alias");
	await symlink(sibling, alias);
	await assert.rejects(f.attach("symlink", "notes", alias), { code: "CONFIG_INVALID" });
	await assert.rejects(f.attach("traversal", "notes", `${parent}/../notes-other`), { code: "CONFIG_INVALID" });
});

test("missing source during restart retains registration without losing healthy roots", async t => {
	const f = await fixture(t);
	const root = await f.source("notes");
	const sub = await f.source("notes/sub");
	const other = await f.source("other");
	await f.start();
	const first = await f.attach("first", "notes", root);
	const second = await f.attach("second", "other", other);
	await first.status();
	await second.status();
	await f.stop();
	await rename(root, join(f.base, "unmounted"));
	const host = await f.start();
	assert.deepEqual([...host.coordinators.keys()], [declarationId(other)]);
	await second.status();
	await assert.rejects(first.status(), { code: "STORE_UNAVAILABLE" });
	await rename(join(f.base, "unmounted"), root);
	await assert.rejects((await f.attach("sub", "sub", sub)).status(), { details: { conflictingFields: ["root"] } });
	await first.status();
	assert.equal(host.coordinators.size, 2);
});
