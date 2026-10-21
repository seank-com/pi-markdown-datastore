export const MARKDOWN_DATASTORE_CONTRACT_VERSION = 1 as const;
export const MARKDOWN_DATASTORE_REQUEST_EVENT = "pi-markdown-datastore:v1:request" as const;
export const MARKDOWN_DATASTORE_CAPABILITY_REQUEST = "pi-markdown-datastore:v1:capability-request" as const;
export const MARKDOWN_DATASTORE_CAPABILITY_REPLY = "pi-markdown-datastore:v1:capability-reply" as const;

/** Discovery reports configured identities; it does not grant any new stores. */
export interface MarkdownDatastoreCapability {
	readonly version: 1;
	readonly contractVersion: 1;
	readonly ready: boolean;
	readonly stores: readonly string[];
	/** Optional additive capability. Policy requests must bind to this instance. */
	readonly policyVersion?: 1;
	readonly instanceId?: string;
}
export interface MarkdownDatastoreCapabilityRequest { version: 1; requestId: string }
export interface MarkdownDatastoreCapabilityReply {
	version: 1; requestId: string; capability: MarkdownDatastoreCapability;
}

export type StoreName = string;
export interface NoteRef { store: StoreName; path: string }
export type NoteUri = string;
export type SearchMode = "lexical" | "semantic" | "hybrid";
export type FreshnessPolicy = "allow-stale" | "require-current-lexical" | "require-current-semantic";
export type ReadView = "content" | "section" | "outline" | "metadata" | "links" | "backlinks" | "related";

export type MarkdownDatastoreErrorCode =
	| "CONFIG_MISSING" | "CONFIG_INVALID" | "CONFIG_VERSION_UNSUPPORTED"
	| "STORE_UNKNOWN" | "STORE_UNAVAILABLE" | "CAPABILITY_UNAVAILABLE" | "PROJECT_UNTRUSTED"
	| "INVALID_NOTE_REF" | "PATH_ESCAPE" | "SYMLINK_REJECTED" | "UNSAFE_FILE_TYPE" | "FILE_TOO_LARGE"
	| "NOTE_NOT_FOUND" | "AMBIGUOUS_NOTE" | "AMBIGUOUS_SECTION"
	| "INVALID_UTF8" | "MARKDOWN_PARSE_ERROR" | "FRONTMATTER_INVALID"
	| "BACKEND_MISSING" | "BACKEND_VERSION_UNSUPPORTED" | "BACKEND_FAILED" | "BACKEND_OUTPUT_INVALID" | "INDEX_CORRUPT"
	| "SEMANTIC_UNAVAILABLE"
	| "STALE_INDEX" | "STALE_CANDIDATE_DROPPED" | "STALE_CONTINUATION" | "EXPIRED_CONTINUATION"
	| "TIMEOUT" | "CANCELLED" | "RESULT_LIMIT_EXCEEDED";

export interface DatastoreWarning { code: MarkdownDatastoreErrorCode; message: string; note?: NoteRef }
export interface SourceProvenance {
	kind: "filesystem" | "qmd";
	backendVersion?: string;
	observationId?: string;
	indexRevision?: string;
	observedAt: string;
	freshness: "current" | "stale" | "unknown";
}
export interface ResultEnvelope<T> {
	contractVersion: 1;
	operation: MarkdownDatastoreRequest["operation"];
	store: string;
	data: T;
	provenance: { sources: SourceProvenance[]; startedAt: string; completedAt: string; durationMs: number };
	bounds: { maxBytes: number; maxLines: number; returnedBytes: number; returnedLines: number; truncated: boolean; continuation?: string };
	warnings: DatastoreWarning[];
}

export interface SearchInput {
	store: StoreName; query: string; mode?: SearchMode; limit?: number; minScore?: number;
	freshness?: FreshnessPolicy; includeContent?: boolean;
}
export interface SearchHit {
	note: NoteRef; uri: NoteUri; path: string; title: string; snippet?: string;
	rank: number; backendRank: number; backend: "qmd"; mode: SearchMode; score?: number;
	sourceRevision: string; indexedRevision: string; sourceMtime: string;
	indexFreshness: "current" | "stale" | "unknown"; truncated: boolean;
}
export interface SearchData { requestedMode: SearchMode; effectiveMode: SearchMode; queueMs?: number; operationMs?: number; workerId?: number; hits: SearchHit[]; examined: number; dropped: number; returned: number }
export type SearchResult = ResultEnvelope<SearchData>;

export type FindSelector =
	| { kind: "path"; path: string }
	| { kind: "uri"; uri: string }
	| { kind: "title"; value: string }
	| { kind: "alias"; value: string }
	| { kind: "tag"; value: string }
	| { kind: "property"; name: string; value: string | number | boolean | null }
	| { kind: "link"; target: string };
export interface FindInput { store: StoreName; selectors: FindSelector[]; match?: "all" | "any"; limit?: number }
export interface FindCandidate { note: NoteRef; uri: NoteUri; title: string; revision: string }
export interface FindData { candidates: FindCandidate[]; examined: number; partial: boolean }
export type FindResult = ResultEnvelope<FindData>;

export interface ReadInput {
	store?: StoreName; note?: NoteRef; uri?: string; view?: ReadView;
	includeFrontmatter?: boolean; headingPath?: string[]; occurrence?: number; sectionHandle?: string;
	excludeSections?: string[]; maxBytes?: number; maxLines?: number; continuation?: string;
	includeSemanticRelated?: boolean;
}
export type ReadData = Record<string, unknown>;
export type ReadResult = ResultEnvelope<ReadData>;
export interface StatusInput { store?: StoreName }
export type StatusResult = ResultEnvelope<{ stores: unknown[]; enabled: boolean }>;
export type RefreshInput =
	| { action?: "start"; store?: StoreName; mode?: "direct" | "lexical" | "semantic" | "all" }
	| { action: "cancel"; refreshId: string };
export type RefreshResult = ResultEnvelope<Record<string, unknown>>;

export type RootsInput = Record<string, never>;
export interface DatastoreRoot { store: string; path: string; device: number; inode: number }
export type RootsResult = ResultEnvelope<{ roots: DatastoreRoot[] }>;
export interface DestinationInput { path: string }
export type DestinationResult = ResultEnvelope<{ path: string; owned: boolean; stores: string[] }>;

export type MarkdownDatastoreRequest =
	| { operation: "roots"; input: RootsInput }
	| { operation: "validateDestination"; input: DestinationInput }
	| { operation: "search"; input: SearchInput }
	| { operation: "find"; input: FindInput }
	| { operation: "read"; input: ReadInput }
	| { operation: "status"; input: StatusInput }
	| { operation: "refresh"; input: RefreshInput };
export type MarkdownDatastoreResult = SearchResult | FindResult | ReadResult | StatusResult | RefreshResult | RootsResult | DestinationResult;

export interface MarkdownDatastorePolicyV1 {
	roots(input: RootsInput, signal?: AbortSignal): Promise<RootsResult>;
	validateDestination(input: DestinationInput, signal?: AbortSignal): Promise<DestinationResult>;
}

export interface MarkdownDatastoreServiceV1 {
	search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult>;
	find(input: FindInput, signal?: AbortSignal): Promise<FindResult>;
	read(input: ReadInput, signal?: AbortSignal): Promise<ReadResult>;
	status(input: StatusInput, signal?: AbortSignal): Promise<StatusResult>;
	refresh(input: RefreshInput, signal?: AbortSignal): Promise<RefreshResult>;
}

export interface MarkdownDatastoreRpcEnvelope {
	contractVersion: 1;
	requestId: string;
	request: MarkdownDatastoreRequest;
	/** Required for policy operations; binds requests to a discovered instance. */
	instanceId?: string;
	deadline: number;
	signal?: AbortSignal;
	resolve(result: MarkdownDatastoreResult): void;
	reject(error: unknown): void;
}
