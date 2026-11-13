import { DatastoreError } from "./errors.ts";

export const HARD_MAX_RESULT_BYTES = 32 * 1024;
export const HARD_MAX_RESULT_LINES = 800;
export const HARD_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_SEARCH_RESULTS = 20;
export const HARD_MAX_CANDIDATES = 500;
export const HARD_MAX_OUTLINE = 100;

export function clampReadBudget(requested: { maxBytes?: unknown; maxLines?: unknown } | undefined, defaults: { maxBytes: number; maxLines: number }): { maxBytes: number; maxLines: number } {
	const maxBytes = requested?.maxBytes === undefined ? defaults.maxBytes : requested.maxBytes;
	const maxLines = requested?.maxLines === undefined ? defaults.maxLines : requested.maxLines;
	if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 4 || typeof maxLines !== "number" || !Number.isInteger(maxLines) || maxLines < 1) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
	return { maxBytes: Math.min(maxBytes, HARD_MAX_RESULT_BYTES), maxLines: Math.min(maxLines, HARD_MAX_RESULT_LINES) };
}

/** Strict JSON duplicate-key pass. JSON.parse alone silently accepts the last duplicate. */
export function assertNoDuplicateJsonKeys(text: string): void {
	let index = 0;
	const ws = () => { while (/\s/.test(text[index] ?? "")) index += 1; };
	const quoted = (): string => {
		const start = index;
		if (text[index++] !== '"') throw new DatastoreError("CONFIG_INVALID");
		let escaped = false;
		while (index < text.length) {
			const char = text[index++];
			if (!escaped && char === '"') {
				try { return JSON.parse(text.slice(start, index)); } catch { throw new DatastoreError("CONFIG_INVALID"); }
			}
			if (!escaped && char === "\\") escaped = true; else escaped = false;
		}
		throw new DatastoreError("CONFIG_INVALID");
	};
	const value = (): void => {
		ws();
		if (text[index] === "{") object();
		else if (text[index] === "[") array();
		else if (text[index] === '"') void quoted();
		else {
			const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
			if (!match) throw new DatastoreError("CONFIG_INVALID");
			index += match[0].length;
		}
	};
	const object = (): void => {
		index += 1; ws(); const keys = new Set<string>();
		if (text[index] === "}") { index += 1; return; }
		for (;;) {
			ws(); const key = quoted();
			if (keys.has(key)) throw new DatastoreError("CONFIG_INVALID");
			keys.add(key); ws(); if (text[index++] !== ":") throw new DatastoreError("CONFIG_INVALID");
			value(); ws(); const delimiter = text[index++];
			if (delimiter === "}") return;
			if (delimiter !== ",") throw new DatastoreError("CONFIG_INVALID");
		}
	};
	const array = (): void => {
		index += 1; ws(); if (text[index] === "]") { index += 1; return; }
		for (;;) { value(); ws(); const delimiter = text[index++]; if (delimiter === "]") return; if (delimiter !== ",") throw new DatastoreError("CONFIG_INVALID"); }
	};
	value(); ws(); if (index !== text.length) throw new DatastoreError("CONFIG_INVALID");
}
