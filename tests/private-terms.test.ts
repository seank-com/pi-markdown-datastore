import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { findPrivateTerms, MIN_SECRET_LENGTH, parsePrivateTerms, parseSecretValues } from "../scripts/check-private-terms.ts";

test("private terms skip blanks and comments and match case-insensitively", () => {
	const terms = parsePrivateTerms("Example Person\n\n# comment\n  example_bot  \n", "terms");
	assert.deepEqual(terms.map((term) => [term.value, term.label]), [["Example Person", "terms line 1"], ["example_bot", "terms line 4"]]);
	assert.deepEqual(findPrivateTerms("ok\nhello EXAMPLE person\nping @Example_Bot", terms, "file"), [
		{ location: "file:2", label: "terms line 1" },
		{ location: "file:3", label: "terms line 4" },
	]);
});

test("secret values parse env lines, strip quotes and ignore short values", () => {
	const secret = "s3cret-value-123";
	const terms = parseSecretValues(`# note\nexport API_TOKEN="${secret}"\nPORT=7351\nFLAG=true\nOTHER='${secret}x'\nnot a line\n`, "env");
	assert.deepEqual(terms.map((term) => [term.label, term.value]), [["env API_TOKEN", secret], ["env OTHER", `${secret}x`]]);
	assert.ok(terms.every((term) => term.value.length >= MIN_SECRET_LENGTH));
	assert.deepEqual(findPrivateTerms(`token ${secret.toUpperCase()}`, terms, "f"), [], "secrets match exactly");
	assert.equal(findPrivateTerms(`token ${secret}`, terms, "f").length, 1);
});

test("hooks refuse private terms in staged files, messages and pushes", () => {
	const root = mkdtempSync(join(tmpdir(), "private-terms-"));
	try {
		const repo = join(root, "repo");
		const remote = join(root, "remote.git");
		const termsFile = join(root, "terms");
		const secretsFile = join(root, "secrets");
		writeFileSync(termsFile, "Example Person\n");
		writeFileSync(secretsFile, "API_TOKEN=s3cret-value-123\n");
		const env = { ...process.env, PRIVATE_TERMS_FILE: termsFile, PRIVATE_SECRETS_FILE: secretsFile, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
		const run = (...args: string[]) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
		const ok = (...args: string[]) => { const result = run(...args); assert.equal(result.status, 0, result.stderr); };
		spawnSync("git", ["init", "-q", "--bare", remote], { env });
		spawnSync("git", ["init", "-q", "-b", "main", repo], { env });
		cpSync(resolve("scripts"), join(repo, "scripts"), { recursive: true });
		cpSync(resolve(".githooks"), join(repo, ".githooks"), { recursive: true });
		for (const hook of ["pre-commit", "commit-msg", "pre-push"]) chmodSync(join(repo, ".githooks", hook), 0o755);
		ok("config", "user.name", "Test");
		ok("config", "user.email", "test@example.test");
		ok("config", "core.hooksPath", ".githooks");
		ok("remote", "add", "origin", remote);

		writeFileSync(join(repo, "clean.md"), "generic text\n");
		ok("add", ".");
		ok("commit", "-q", "-m", "Clean commit");

		writeFileSync(join(repo, "existing.md"), "by Example Person\n");
		ok("add", "existing.md");
		ok("commit", "-q", "--no-verify", "-m", "Existing approved text");
		writeFileSync(join(repo, "clean.md"), "generic text\nmore text\n");
		ok("add", "clean.md");
		ok("commit", "-q", "-m", "Unrelated change is not blocked by existing text");
		const all = spawnSync(process.execPath, ["scripts/check-private-terms.ts", "--all"], { cwd: repo, env, encoding: "utf8" });
		assert.equal(all.status, 1);
		assert.match(all.stderr, /existing\.md:1: matches/);
		ok("push", "-q", "--no-verify", "origin", "main");

		writeFileSync(join(repo, "leak.md"), "hello\nwritten by example person\n");
		ok("add", "leak.md");
		const staged = run("commit", "-q", "-m", "Leaky file");
		assert.notEqual(staged.status, 0);
		assert.match(staged.stderr, /leak\.md:2: matches .*terms line 1/);
		ok("rm", "-q", "--cached", "leak.md");

		const message = run("commit", "-q", "--allow-empty", "-m", "Uses s3cret-value-123");
		assert.notEqual(message.status, 0);
		assert.match(message.stderr, /commit message:1: matches .*secrets API_TOKEN/);
		assert.doesNotMatch(message.stderr, /s3cret-value-123/, "secret values are never printed");

		ok("commit", "-q", "--no-verify", "--allow-empty", "-m", "Bypassed Example Person");
		const push = run("push", "-q", "origin", "main");
		assert.notEqual(push.status, 0);
		assert.match(push.stderr, /message:1: matches .*terms line 1/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
