// Refuses commits and pushes that contain private terms or local secret values.
// Terms come from ~/.pii (one per line, matched case-insensitively) and secret
// values from ~/.env (KEY=value lines, matched exactly). Missing files are
// skipped, so the check passes trivially where neither exists, such as CI.
// By default it checks lines added in staged changes; --all checks every
// staged file, --message a commit message, and --range commits being pushed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PrivateTerm {
	value: string;
	label: string;
	caseInsensitive: boolean;
}

export interface Finding {
	location: string;
	label: string;
}

/** Shorter secret values (flags, ports, booleans) would match ordinary text. */
export const MIN_SECRET_LENGTH = 8;

export function parsePrivateTerms(text: string, source: string): PrivateTerm[] {
	const terms: PrivateTerm[] = [];
	text.split(/\r?\n/).forEach((raw, index) => {
		const value = raw.trim();
		if (value && !value.startsWith("#")) terms.push({ value, label: `${source} line ${index + 1}`, caseInsensitive: true });
	});
	return terms;
}

export function parseSecretValues(text: string, source: string): PrivateTerm[] {
	const terms: PrivateTerm[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
		if (!match) continue;
		let value = match[2]!.trim();
		if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
		if (value.length >= MIN_SECRET_LENGTH) terms.push({ value, label: `${source} ${match[1]}`, caseInsensitive: false });
	}
	return terms;
}

export function findPrivateTerms(text: string, terms: readonly PrivateTerm[], location: string): Finding[] {
	const findings: Finding[] = [];
	text.split("\n").forEach((line, index) => {
		const folded = line.toLowerCase();
		for (const term of terms) {
			const found = term.caseInsensitive ? folded.includes(term.value.toLowerCase()) : line.includes(term.value);
			if (found) findings.push({ location: `${location}:${index + 1}`, label: term.label });
		}
	});
	return findings;
}

function loadTerms(): PrivateTerm[] {
	const termsPath = process.env.PRIVATE_TERMS_FILE ?? join(homedir(), ".pii");
	const secretsPath = process.env.PRIVATE_SECRETS_FILE ?? join(homedir(), ".env");
	const terms: PrivateTerm[] = [];
	if (existsSync(termsPath)) terms.push(...parsePrivateTerms(readFileSync(termsPath, "utf8"), termsPath));
	if (existsSync(secretsPath)) terms.push(...parseSecretValues(readFileSync(secretsPath, "utf8"), secretsPath));
	return terms;
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Every file as staged for the next commit, including unchanged ones. */
function scanIndex(terms: readonly PrivateTerm[]): Finding[] {
	const findings: Finding[] = [];
	for (const entry of git(["ls-files", "--stage", "-z"]).split("\0")) {
		const match = /^\d+ ([0-9a-f]+) \d+\t(.+)$/s.exec(entry);
		if (!match) continue;
		findings.push(...findPrivateTerms(git(["cat-file", "blob", match[1]!]), terms, match[2]!));
	}
	return findings;
}

/** Commit messages and added lines for every commit in a revision range. */
function scanRange(range: string[], terms: readonly PrivateTerm[]): Finding[] {
	const findings: Finding[] = [];
	const log = git(["log", "-p", "--no-color", "--no-ext-diff", "--format=%x00%h%n%B%x00", ...range]);
	const parts = log.split("\0");
	for (let index = 1; index + 1 < parts.length; index += 2) {
		const [commit, ...message] = parts[index]!.split("\n");
		findings.push(...findPrivateTerms(message.join("\n"), terms, `${commit} message`));
		findings.push(...scanDiff(parts[index + 1]!, terms, `${commit} `));
	}
	return findings;
}

/** Added lines in a unified diff, located by file and new line number. */
function scanDiff(diff: string, terms: readonly PrivateTerm[], prefix = ""): Finding[] {
	const findings: Finding[] = [];
	let file = "";
	let line = 0;
	for (const diffLine of diff.split("\n")) {
		if (diffLine.startsWith("+++ ")) file = diffLine.replace(/^\+\+\+ (b\/)?/, "");
		else if (diffLine.startsWith("@@")) line = Number(/\+(\d+)/.exec(diffLine)?.[1] ?? 0);
		else if (diffLine.startsWith("+")) {
			for (const finding of findPrivateTerms(diffLine.slice(1), terms, "")) findings.push({ location: `${prefix}${file}:${line}`, label: finding.label });
			line += 1;
		} else if (!diffLine.startsWith("-") && !diffLine.startsWith("\\")) line += 1;
	}
	return findings;
}

function main(argv: string[]): number {
	const terms = loadTerms();
	if (terms.length === 0) {
		console.log("check-private-terms: no ~/.pii or ~/.env terms found; nothing to check.");
		return 0;
	}
	let findings: Finding[];
	if (argv[0] === "--message" && argv[1]) findings = findPrivateTerms(readFileSync(argv[1], "utf8"), terms, "commit message");
	else if (argv[0] === "--range" && argv.length > 1) findings = scanRange(argv.slice(1), terms);
	else if (argv[0] === "--all" && argv.length === 1) findings = scanIndex(terms);
	else if (argv.length === 0) findings = scanDiff(git(["diff", "--cached", "-p", "--no-color", "--no-ext-diff"]), terms);
	else {
		console.error("usage: check-private-terms.ts [--all | --message FILE | --range REVISION...]");
		return 2;
	}
	for (const finding of findings) console.error(`${finding.location}: matches ${finding.label}`);
	if (findings.length) console.error(`check-private-terms: ${findings.length} private term match(es); nothing was committed or pushed.`);
	return findings.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
