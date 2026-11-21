import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadMarkdownDatastoreConfig } from "../src/config.ts";
import { SharedIndexClient } from "../src/shared-client.ts";
import { startSharedHost, type SharedHost } from "../src/shared-host.ts";
import { declarationId } from "../src/shared-registrations.ts";

async function fixture(t: TestContext) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "ds-")));
	const home = process.env.HOME;
	process.env.HOME = base;
	let host: SharedHost | undefined;
	const clients: SharedIndexClient[] = [];
	t.after(async () => {
		if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
		await Promise.all(clients.map(client => client.shutdown()));
		await host?.close();
		await rm(base, { recursive: true, force: true });
	});
	const settings = join(base, ".pi", "markdown-datastore", "host.json");
	const snapshot = join(dirname(settings), "registrations.json");
	const stateRoot = join(base, "state");
	const socketPath = join(base, "run", "s");
	await mkdir(dirname(settings), { recursive: true, mode: 0o700 });
	await writeFile(settings, JSON.stringify({ schemaVersion: 1, socketPath, stateRoot,
		defaults: { operationTimeoutMs: 10000 }, qmd: { enabled: false, installation: { executable: "unused" }, minimumVersion: "2.8.3" },
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
	return { base, settings, snapshot, stateRoot, source, attach, start: async () => host = await startSharedHost(settings, { declarations: true }), stop: async () => { await host?.close(); host = undefined; } };
}

test("registration reconstructs with zero clients, then from any matching declaration after snapshot loss", async t => {
	const f = await fixture(t);
	const root = await f.source("notes");
	const other = await f.source("notes-other");
	const first = await f.attach("first", "notes", root + "/", ["a", "b", "b"]);
	const second = await f.attach("second", "other", root, ["a", "b", "b"], ["**/*.md"]);
	const host = await f.start();
	assert.equal(host.coordinators.size, 0);
	await assert.rejects(startSharedHost(f.settings, { declarations: true }), { code: "STORE_UNAVAILABLE" });
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

test("overlapping admissions serialize and failed publication leaves no partial store", async t => {
	const f = await fixture(t);
	const parent = await f.source("notes");
	const child = await f.source("notes/child");
	const sibling = await f.source("notes-other");
	const host = await f.start();
	const first = await f.attach("first", "notes", parent);
	await mkdir(f.snapshot);
	await assert.rejects(first.status(), { code: "STORE_UNAVAILABLE" });
	assert.equal(host.catalog.stores.size, 0);
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
