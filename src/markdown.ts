import { fromMarkdown } from "mdast-util-from-markdown";
import { parseDocument } from "yaml";
import type { Root, Heading } from "mdast";
import type { SafeNote } from "./containment.ts";
import { DatastoreError } from "./errors.ts";

export interface FrontmatterResult {
	present: boolean; startLine?: number; endLine?: number; value?: Record<string, unknown>;
	aliases: string[]; tags: string[]; error?: "FRONTMATTER_INVALID";
}
export interface SectionDescriptor {
	heading: string; depth: number; headingPath: string[]; occurrence: number; startLine: number; endLine: number;
}
export interface ParsedNote { frontmatter: FrontmatterResult; outline: SectionDescriptor[]; title: string; lines: string[] }

export function extractEmbedTargets(note: SafeNote): string[] {
	const lines = note.text.split(/\r\n|\n|\r/); const frontmatter = parseFrontmatter(lines); const parserLines = [...lines];
	if (frontmatter.present) { const end = frontmatter.endLine ?? lines.length; for (let index = 0; index < end; index += 1) parserLines[index] = ""; }
	let root: Root; try { root = fromMarkdown(parserLines.join("\n")); } catch { throw new DatastoreError("MARKDOWN_PARSE_ERROR"); }
	const targets: string[] = []; const visit = (node: any): void => {
		if (node?.type === "image" && typeof node.url === "string") targets.push(node.url);
		if (node?.type === "text" && typeof node.value === "string") for (const match of node.value.matchAll(/!\[\[([^\]\r\n]+)\]\]/gu)) targets.push(match[1]);
		if (targets.length > 500) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
		if (Array.isArray(node?.children)) for (const child of node.children) visit(child);
	}; visit(root); return targets;
}

function scalarText(node: any): string {
	if (typeof node?.value === "string") return node.value;
	if (!Array.isArray(node?.children)) return "";
	return node.children.map(scalarText).join("");
}
function yamlBounds(value: unknown, depth = 0, state = { nodes: 0 }): void {
	state.nodes += 1;
	if (depth > 8 || state.nodes > 1000) throw new DatastoreError("FRONTMATTER_INVALID");
	if (typeof value === "string" && Buffer.byteLength(value) > 16 * 1024) throw new DatastoreError("FRONTMATTER_INVALID");
	if (Array.isArray(value)) for (const child of value) yamlBounds(child, depth + 1, state);
	else if (value && typeof value === "object") for (const child of Object.values(value as Record<string, unknown>)) yamlBounds(child, depth + 1, state);
}
function normalizedList(value: unknown, tag = false): string[] {
	const values = typeof value === "string" ? [value] : Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
	return values.map((item) => tag && item.startsWith("#") ? item.slice(1) : item);
}

function parseFrontmatter(lines: string[]): FrontmatterResult {
	const first = lines[0]?.replace(/^\uFEFF/, "");
	if (first !== "---") return { present: false, aliases: [], tags: [] };
	const close = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
	if (close < 0) return { present: true, aliases: [], tags: [], error: "FRONTMATTER_INVALID" };
	try {
		const document = parseDocument(lines.slice(1, close).join("\n"), { schema: "core", uniqueKeys: true });
		if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("invalid YAML");
		const value = document.toJS({ maxAliasCount: 10 });
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("frontmatter must be a mapping");
		yamlBounds(value);
		const mapping = value as Record<string, unknown>;
		return { present: true, startLine: 1, endLine: close + 1, value: mapping, aliases: normalizedList(mapping.aliases), tags: normalizedList(mapping.tags, true) };
	} catch {
		return { present: true, startLine: 1, endLine: close + 1, aliases: [], tags: [], error: "FRONTMATTER_INVALID" };
	}
}

export function parseMarkdown(note: SafeNote): ParsedNote {
	const lines = note.text.split(/\r\n|\n|\r/);
	const frontmatter = parseFrontmatter(lines);
	const parserText = [...lines];
	if (frontmatter.present) {
		const end = frontmatter.endLine ?? lines.length;
		for (let index = 0; index < end; index += 1) parserText[index] = "";
	}
	let root: Root;
	try { root = fromMarkdown(parserText.join("\n")); } catch { throw new DatastoreError("MARKDOWN_PARSE_ERROR"); }
	const headings = root.children.filter((node): node is Heading => node.type === "heading" && node.position !== undefined);
	const outline: SectionDescriptor[] = [];
	const stack: Array<{ depth: number; text: string }> = [];
	const siblingCounts = new Map<string, number>();
	for (let index = 0; index < headings.length; index += 1) {
		const node = headings[index];
		const heading = scalarText(node).trim();
		while (stack.length > 0 && stack[stack.length - 1].depth >= node.depth) stack.pop();
		const headingPath = [...stack.map((item) => item.text), heading];
		const siblingKey = `${node.depth}\u0000${stack.map((item) => item.text).join("\u0000")}\u0000${heading}`;
		const occurrence = siblingCounts.get(siblingKey) ?? 0;
		siblingCounts.set(siblingKey, occurrence + 1);
		let endLine = lines.length;
		for (let next = index + 1; next < headings.length; next += 1) {
			if (headings[next].depth <= node.depth) { endLine = (headings[next].position?.start.line ?? lines.length + 1) - 1; break; }
		}
		outline.push({ heading, depth: node.depth, headingPath, occurrence, startLine: node.position!.start.line, endLine });
		stack.push({ depth: node.depth, text: heading });
	}
	const metadataTitle = frontmatter.value?.title;
	const firstH1 = outline.find((entry) => entry.depth === 1)?.heading;
	const fallback = note.note.path.split("/").at(-1)!.replace(/\.md$/, "");
	const title = typeof metadataTitle === "string" && metadataTitle.trim() ? metadataTitle.trim() : firstH1 || fallback;
	return { frontmatter, outline, title, lines };
}

export function selectSection(parsed: ParsedNote, headingPath?: string[], occurrence = 0): SectionDescriptor {
	if (!headingPath?.length) throw new DatastoreError("AMBIGUOUS_SECTION");
	const candidates = parsed.outline.filter((entry) => entry.headingPath.length === headingPath.length && entry.headingPath.every((part, index) => part === headingPath[index]));
	if (candidates.length === 0) throw new DatastoreError("NOTE_NOT_FOUND");
	const exact = candidates.find((entry) => entry.occurrence === occurrence);
	if (!exact || (occurrence === 0 && candidates.length > 1)) throw new DatastoreError("AMBIGUOUS_SECTION", { candidates: candidates.slice(0, 20) });
	return exact;
}

export function sectionText(parsed: ParsedNote, section: SectionDescriptor): string {
	return parsed.lines.slice(section.startLine - 1, section.endLine).join("\n");
}

export function contentWithoutSections(parsed: ParsedNote, text: string, exclusions: SectionDescriptor[]): string {
	if (exclusions.length === 0) return text;
	const excluded = new Set<number>();
	for (const section of exclusions) for (let line = section.startLine; line <= section.endLine; line += 1) excluded.add(line);
	return parsed.lines.filter((_line, index) => !excluded.has(index + 1)).join("\n");
}

export interface Page { content: string; nextCursor?: number; returnedBytes: number; returnedLines: number; truncated: boolean; longLine: boolean }
export function boundedPage(text: string, cursor: number, maxBytes: number, maxLines: number): Page {
	if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) throw new DatastoreError("EXPIRED_CONTINUATION");
	let index = cursor; let bytes = 0; let newlines = 0; let output = ""; let longLine = false;
	while (index < text.length) {
		const point = text.codePointAt(index)!;
		const char = String.fromCodePoint(point);
		const charBytes = Buffer.byteLength(char);
		if (bytes + charBytes > maxBytes || (char === "\n" && newlines + 1 >= maxLines)) { longLine = newlines === 0 && !output.includes("\n"); break; }
		output += char; bytes += charBytes; if (char === "\n") newlines += 1; index += char.length;
	}
	if (index < text.length && output.length === 0) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
	return { content: output, nextCursor: index < text.length ? index : undefined, returnedBytes: bytes, returnedLines: output.length === 0 ? 0 : newlines + 1, truncated: index < text.length, longLine };
}
