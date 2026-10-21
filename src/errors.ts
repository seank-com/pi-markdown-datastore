import type { MarkdownDatastoreErrorCode } from "./contract.ts";

const SAFE_MESSAGES: Record<MarkdownDatastoreErrorCode, string> = {
	CONFIG_MISSING: "Markdown datastore configuration is absent.",
	CONFIG_INVALID: "Markdown datastore configuration is invalid.",
	CONFIG_VERSION_UNSUPPORTED: "Markdown datastore configuration version is unsupported.",
	PROJECT_UNTRUSTED: "Markdown datastore is disabled because the project is untrusted.",
	STORE_UNKNOWN: "The requested datastore is not configured.",
	STORE_UNAVAILABLE: "The requested datastore is unavailable.",
	CAPABILITY_UNAVAILABLE: "The requested datastore capability is unavailable.",
	INVALID_NOTE_REF: "The note reference is invalid.", PATH_ESCAPE: "The note path escapes its configured store.",
	SYMLINK_REJECTED: "A filesystem symlink alias was rejected.", UNSAFE_FILE_TYPE: "The note is not a safe regular file.",
	FILE_TOO_LARGE: "The note exceeds the configured file limit.", NOTE_NOT_FOUND: "The requested note was not found.",
	AMBIGUOUS_NOTE: "The note selector is ambiguous.", AMBIGUOUS_SECTION: "The section selector is ambiguous.",
	INVALID_UTF8: "The note is not valid UTF-8.", MARKDOWN_PARSE_ERROR: "The note could not be parsed as Markdown.",
	FRONTMATTER_INVALID: "The note frontmatter is invalid.", BACKEND_MISSING: "The configured backend is unavailable.",
	BACKEND_VERSION_UNSUPPORTED: "The backend version is unsupported.", BACKEND_FAILED: "The datastore backend failed.",
	BACKEND_OUTPUT_INVALID: "The datastore backend returned invalid output.", INDEX_CORRUPT: "The datastore index failed integrity validation.",
	SEMANTIC_UNAVAILABLE: "Embedding underway; try again later.",
	STALE_INDEX: "The datastore index is stale.", STALE_CANDIDATE_DROPPED: "A stale backend candidate was dropped.",
	STALE_CONTINUATION: "The note changed after the continuation was issued.",
	EXPIRED_CONTINUATION: "The continuation is expired or unavailable.", TIMEOUT: "The datastore operation timed out.",
	CANCELLED: "The datastore operation was cancelled.", RESULT_LIMIT_EXCEEDED: "The datastore result exceeded its hard limit.",
};

const READ_VIEWS = new Set(["content", "section", "outline", "metadata", "links", "backlinks", "related"]);
const READ_OPTIONS = new Set(["includeFrontmatter", "headingPath", "occurrence", "sectionHandle", "excludeSections", "includeSemanticRelated"]);
function safeMessage(code: MarkdownDatastoreErrorCode, details?: Readonly<Record<string, unknown>>): string {
	if (code === "INVALID_NOTE_REF" && details?.reason === "OPTION_NOT_ALLOWED" && typeof details.view === "string" && READ_VIEWS.has(details.view) && typeof details.option === "string" && READ_OPTIONS.has(details.option)) return `The ${details.option} option is not valid for the ${details.view} view.`;
	return SAFE_MESSAGES[code];
}

export class DatastoreError extends Error {
	readonly code: MarkdownDatastoreErrorCode;
	readonly details?: Readonly<Record<string, unknown>>;
	constructor(code: MarkdownDatastoreErrorCode, details?: Readonly<Record<string, unknown>>, cause?: unknown) {
		super(`${code}: ${safeMessage(code, details)}`, cause === undefined ? undefined : { cause });
		this.name = "DatastoreError";
		this.code = code;
		this.details = details;
	}
}

export function datastoreError(error: unknown, fallback: MarkdownDatastoreErrorCode = "BACKEND_FAILED"): DatastoreError {
	if (error instanceof DatastoreError) return error;
	if (error instanceof Error && error.name === "AbortError") return new DatastoreError("CANCELLED");
	return new DatastoreError(fallback, undefined, error);
}

export function abortError(signal?: AbortSignal): DatastoreError {
	return signal?.reason instanceof DatastoreError ? signal.reason : new DatastoreError("CANCELLED");
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}
