import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { findPrivateTerms, parsePrivateTerms, parseSecretValues } from "../scripts/check-private-terms.ts";

test("private terms skip blanks and comments and match case-insensitively", () => {
	const terms = parsePrivateTerms("Example Person\n\n# comment\n  example_bot  \n", "terms");
	assert.deepEqual(terms.map((term) => [term.value, term.label]), [["Example Person", "terms line 1"], ["example_bot", "terms line 4"]]);
	assert.deepEqual(findPrivateTerms("ok\nhello EXAMPLE person\nping @Example_Bot", terms, "file"), [
		{ location: "file:2", label: "terms line 1" },
		{ location: "file:3", label: "terms line 4" },
	]);
});

test("secret values select credential names, strip quotes and include short nonempty values", () => {
	const secret = "s3cret-value-123";
	const terms = parseSecretValues(`# note\nexport API_TOKEN="${secret}"\nPORT=7351\nFLAG=true\nOTHER='${secret}x'\nDB_PASSWORD='q7!'\nSERVICE_API_KEY=x\nTOKEN_COUNT=0\nEMPTY_TOKEN=\nBLANK_PASSWORD=''\nlower_token=${secret}lower\nnot a line\n`, "env");
	assert.deepEqual(terms.map((term) => [term.label, term.value]), [["env API_TOKEN", secret], ["env DB_PASSWORD", "q7!"], ["env SERVICE_API_KEY", "x"], ["env TOKEN_COUNT", "0"]]);
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
		writeFileSync(secretsFile, "API_TOKEN=s3cret-value-123\nAPP_PASSWORD=q7!\n");
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

		ok("switch", "-q", "-c", "feature");
		ok("commit", "-q", "--allow-empty", "-m", "Clean feature");
		ok("push", "-q", "origin", "feature");
		ok("switch", "-q", "main");
		writeFileSync(join(repo, "accepted-main.md"), "Example Person\n");
		ok("add", "accepted-main.md");
		ok("commit", "-q", "--no-verify", "-m", "Accepted main Example Person");
		ok("push", "-q", "--no-verify", "origin", "main");
		ok("switch", "-q", "feature");
		ok("merge", "-q", "--no-verify", "--no-ff", "origin/main", "-m", "Merge accepted main");
		const updated = run("push", "-q", "origin", "feature");
		assert.equal(updated.status, 0, `published main history must not block the feature: ${updated.stderr}`);
		const cleanFeature = run("rev-parse", "HEAD").stdout.trim();
		for (const kind of ["message", "line"]) {
			if (kind === "line") {
				writeFileSync(join(repo, "feature-leak.md"), "Example Person\n");
				ok("add", "feature-leak.md");
			}
			ok("commit", "-q", "--no-verify", "--allow-empty", "-m", kind === "message" ? "Feature Example Person" : "Feature line");
			const refused = run("push", "-q", "origin", "feature");
			assert.notEqual(refused.status, 0, `feature ${kind} must still be checked`);
			assert.match(refused.stderr, kind === "message" ? /message:1: matches/ : /feature-leak\.md:1: matches/);
			ok("reset", "-q", "--hard", cleanFeature);
		}
		ok("commit", "-q", "--allow-empty", "-m", "Ordinary feature update");
		ok("push", "-q", "origin", "feature");
		const newBase = run("rev-parse", "HEAD").stdout.trim();
		ok("switch", "-q", "-c", "new-feature");
		ok("commit", "-q", "--no-verify", "--allow-empty", "-m", "New branch Example Person");
		assert.notEqual(run("push", "-q", "origin", "new-feature").status, 0, "new branch leak must still fail");
		ok("reset", "-q", "--hard", newBase);
		ok("commit", "-q", "--allow-empty", "-m", "Clean new branch");
		ok("push", "-q", "origin", "new-feature");
		ok("switch", "-q", "main");

		writeFileSync(join(repo, "leak.md"), "hello\nwritten by example person\n");
		ok("add", "leak.md");
		const staged = run("commit", "-q", "-m", "Leaky file");
		assert.notEqual(staged.status, 0);
		assert.match(staged.stderr, /leak\.md:2: matches .*terms line 1/);
		ok("rm", "-q", "--cached", "leak.md");

		writeFileSync(join(repo, "short.md"), "q7!\n");
		ok("add", "short.md");
		const short = run("commit", "-q", "-m", "Short credential");
		assert.notEqual(short.status, 0);
		assert.match(short.stderr, /short\.md:1: matches .*secrets APP_PASSWORD/);
		assert.doesNotMatch(short.stderr, /q7!/, "short secret values are never printed");
		ok("rm", "-q", "--cached", "short.md");

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
