import { codeRanges } from "./markdown.ts";

export interface WikiReference {
	kind: "link" | "embed";
	raw: string;
	target: string;
	fragment?: string;
	suffix?: string;
	line: number;
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < text.length; index += 1) if (text[index] === "\n") line += 1;
	return line;
}

/** Raw-text wikilinks outside parser-identified code. Decoded AST text is not a source of edges. */
export function extractWikilinks(text: string, frontmatterEndLine = 0): WikiReference[] {
	const source = text.replace(/\r\n|\r/g, "\n");
	const ranges = codeRanges(source, frontmatterEndLine);
	const frontmatterEnd = frontmatterEndLine === 0 ? 0 : source.split("\n").slice(0, frontmatterEndLine).join("\n").length + 1;
	const refs: WikiReference[] = [];
	let index = Math.max(0, frontmatterEnd);
	while (index < source.length) {
		if (source[index] === "\\") { index += 2; continue; }
		if (ranges.some(([start, end]) => index >= start && index < end)) { index += 1; continue; }
		const embed = source.startsWith("![[", index);
		const open = embed || source.startsWith("[[", index);
		if (!open) { index += 1; continue; }
		const start = index;
		index += embed ? 3 : 2;
		const close = source.indexOf("]]", index);
		if (close < 0) { index = start + 1; continue; }
		if (ranges.some(([rangeStart, rangeEnd]) => start >= rangeStart && start < rangeEnd)) { index = close + 2; continue; }
		const inner = source.slice(index, close);
		const raw = source.slice(start, close + 2);
		const pipe = inner.indexOf("|");
		const body = pipe >= 0 ? inner.slice(0, pipe) : inner;
		const suffix = pipe >= 0 ? inner.slice(pipe + 1) : undefined;
		const hash = body.indexOf("#");
		const target = (hash >= 0 ? body.slice(0, hash) : body).trim();
		const fragment = hash >= 0 ? body.slice(hash + 1) : undefined;
		if (target.length > 0 || fragment) refs.push({ kind: embed ? "embed" : "link", raw, target, fragment, suffix, line: lineOf(source, start) });
		index = close + 2;
	}
	return refs;
}

export function tagIdentity(value: string): string {
	const stripped = value.startsWith("#") ? value.slice(1) : value;
	return stripped.toLocaleLowerCase("en-US");
}
