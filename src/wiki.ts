export interface WikiReference {
	kind: "link" | "embed";
	raw: string;
	target: string;
	fragment?: string;
	suffix?: string;
	line: number;
}

function fencedLines(lines: string[]): Set<number> {
	const skip = new Set<number>();
	let fence: string | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const marker = /^( {0,3})(`{3,}|~{3,})/.exec(lines[index]);
		if (!fence && marker) { fence = marker[2][0]; skip.add(index); continue; }
		if (fence && new RegExp(`^ {0,3}${fence}{3,}`).test(lines[index])) { skip.add(index); fence = undefined; continue; }
		if (fence) skip.add(index);
	}
	return skip;
}

/** Raw-text wikilinks. Decoded AST text is not a source of edges. */
export function extractWikilinks(text: string, frontmatterEndLine = 0): WikiReference[] {
	const lines = text.split(/\r\n|\n|\r/);
	const skip = fencedLines(lines);
	for (let index = 0; index < frontmatterEndLine; index += 1) skip.add(index);
	const refs: WikiReference[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		if (skip.has(lineIndex)) continue;
		const line = lines[lineIndex];
		let index = 0;
		let inline = false;
		while (index < line.length) {
			const char = line[index];
			if (char === "\\") { index += 2; continue; }
			if (char === "`") { inline = !inline; index += 1; continue; }
			if (inline) { index += 1; continue; }
			const embed = line.startsWith("![[", index);
			const open = embed || line.startsWith("[[", index);
			if (!open) { index += 1; continue; }
			const start = index;
			index += embed ? 3 : 2;
			const close = line.indexOf("]]", index);
			if (close < 0) { index = start + 1; continue; }
			const inner = line.slice(index, close);
			const raw = line.slice(start, close + 2);
			const pipe = inner.indexOf("|");
			const body = pipe >= 0 ? inner.slice(0, pipe) : inner;
			const suffix = pipe >= 0 ? inner.slice(pipe + 1) : undefined;
			const hash = body.indexOf("#");
			const target = (hash >= 0 ? body.slice(0, hash) : body).trim();
			const fragment = hash >= 0 ? body.slice(hash + 1) : undefined;
			if (target.length > 0 || fragment) refs.push({ kind: embed ? "embed" : "link", raw, target, fragment, suffix, line: lineIndex + 1 });
			index = close + 2;
		}
	}
	return refs;
}

export function tagIdentity(value: string): string {
	const stripped = value.startsWith("#") ? value.slice(1) : value;
	return stripped.toLocaleLowerCase("en-US");
}
