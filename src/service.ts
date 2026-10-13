import { lstat } from "node:fs/promises";
import type {
	FindInput, FindResult, MarkdownDatastoreServiceV1, ReadInput, ReadResult, RefreshInput, RefreshResult,
	ResultEnvelope, SearchHit, SearchInput, SearchResult, StatusInput, StatusResult,
} from "./contract.ts";
import type { MarkdownDatastoreConfig, StoreConfig } from "./config.ts";
import { HARD_MAX_RESULT_BYTES, HARD_MAX_RESULT_LINES } from "./config.ts";
import { noteUriToRef, redactedRoot, safeOpenNote, validateRelativeNotePath } from "./containment.ts";
import { ContinuationRegistry, type ContinuationDescriptor } from "./continuations.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import { boundedPage, contentWithoutSections, parseMarkdown, sectionText, selectSection, type SectionDescriptor } from "./markdown.ts";
import type { QmdAdapter, QmdCandidate } from "./qmd-adapter.ts";

function elapsed(started: number): number { return Math.max(0, Date.now() - started); }
function propagateControlError(error: unknown): void { if (error instanceof DatastoreError && (error.code === "CANCELLED" || error.code === "TIMEOUT")) throw error; }
function lines(value: string): number { return value.length === 0 ? 0 : value.split("\n").length; }
function boundedArrays(first: unknown[], second: unknown[], firstKey: string, secondKey: string, base: Record<string, unknown>, maximum: number, budget: { maxBytes: number; maxLines: number }): { first: unknown[]; second: unknown[]; text: string; returnedLines: number; truncated: boolean } {
	const selectedFirst: unknown[] = []; const selectedSecond: unknown[] = []; let truncated = false;
	for (const [target, items] of [[selectedFirst, first], [selectedSecond, second]] as const) for (const item of items) { const candidate = [...target, item]; const data = { ...base, [firstKey]: target === selectedFirst ? candidate : selectedFirst, [secondKey]: target === selectedSecond ? candidate : selectedSecond }; const text = JSON.stringify(data); if (selectedFirst.length + selectedSecond.length >= maximum || Buffer.byteLength(text) > budget.maxBytes || selectedFirst.length + selectedSecond.length + 1 > budget.maxLines) { truncated = true; continue; } target.push(item); }
	const text = JSON.stringify({ ...base, [firstKey]: selectedFirst, [secondKey]: selectedSecond }); return { first: selectedFirst, second: selectedSecond, text, returnedLines: Math.max(1, selectedFirst.length + selectedSecond.length), truncated };
}

export class MarkdownDatastoreService implements MarkdownDatastoreServiceV1 {
	readonly config: MarkdownDatastoreConfig;
	readonly continuations: ContinuationRegistry;
	readonly qmd?: QmdAdapter;
	#lifecycle = new AbortController(); #active = new Set<Promise<unknown>>(); #closed = false;
	constructor(config: MarkdownDatastoreConfig, continuations = new ContinuationRegistry(), qmd?: QmdAdapter) { this.config = config; this.continuations = continuations; this.qmd = qmd; }
	private runOperation<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new DatastoreError("CANCELLED"));
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(new DatastoreError("TIMEOUT")), 15 * 60_000);
		const operationSignal = AbortSignal.any([this.#lifecycle.signal, deadline.signal, ...(signal ? [signal] : [])]);
		const operation = Promise.resolve().then(() => { throwIfAborted(operationSignal); return work(operationSignal); });
		this.#active.add(operation); void operation.finally(() => { clearTimeout(timer); this.#active.delete(operation); }).catch(() => undefined); return operation;
	}
	search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult> { return this.runOperation(signal, (activeSignal) => this.searchInner(input, activeSignal)); }
	find(input: FindInput, signal?: AbortSignal): Promise<FindResult> { return this.runOperation(signal, (activeSignal) => this.findInner(input, activeSignal)); }
	read(input: ReadInput, signal?: AbortSignal): Promise<ReadResult> { return this.runOperation(signal, (activeSignal) => this.readInner(input, activeSignal)); }
	status(input: StatusInput, signal?: AbortSignal): Promise<StatusResult> { return this.runOperation(signal, (activeSignal) => this.statusInner(input, activeSignal)); }
	refresh(input: RefreshInput, signal?: AbortSignal): Promise<RefreshResult> { return this.runOperation(signal, (activeSignal) => this.refreshInner(input, activeSignal)); }
	private store(name: string | undefined): StoreConfig {
		if (!name) throw new DatastoreError("STORE_UNKNOWN");
		const store = this.config.stores.get(name);
		if (!store) throw new DatastoreError("STORE_UNKNOWN", { store: name });
		return store;
	}
	private envelope<T>(operation: ResultEnvelope<T>["operation"], store: string, data: T, started: number, text = "", truncated = false, continuation?: string, sources: ResultEnvelope<T>["provenance"]["sources"] = [], warnings: ResultEnvelope<T>["warnings"] = [], budget?: { maxBytes: number; maxLines: number }, measuredLines?: number): ResultEnvelope<T> {
		const effectiveBudget = budget ?? { maxBytes: this.config.defaults.maxResultBytes, maxLines: this.config.defaults.maxResultLines }; const returnedBytes = Buffer.byteLength(text); const returnedLines = measuredLines ?? lines(text); if (returnedBytes > effectiveBudget.maxBytes || returnedLines > effectiveBudget.maxLines) throw new DatastoreError("RESULT_LIMIT_EXCEEDED"); const completedAt = new Date().toISOString();
		const result: ResultEnvelope<T> = {
			contractVersion: 1, operation, store, data,
			provenance: { sources, startedAt: new Date(started).toISOString(), completedAt, durationMs: elapsed(started) },
			bounds: { maxBytes: effectiveBudget.maxBytes, maxLines: effectiveBudget.maxLines, returnedBytes, returnedLines, truncated, continuation },
			warnings,
		};
		const serialized = JSON.stringify(result);
		if (Buffer.byteLength(serialized) > HARD_MAX_RESULT_BYTES || lines(serialized) > HARD_MAX_RESULT_LINES) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
		return result;
	}
	private async searchInner(input: SearchInput, signal: AbortSignal): Promise<SearchResult> {
		const started = Date.now(); throwIfAborted(signal); const store = this.store(input.store);
		if (!this.qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
		if (typeof input.query !== "string" || !input.query.trim() || Buffer.byteLength(input.query) > 4096) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
		const mode = input.mode ?? store.search.defaultMode; const limit = input.limit ?? 5;
		if (input.minScore !== undefined && !Number.isFinite(input.minScore)) throw new DatastoreError("INVALID_NOTE_REF");
		if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !["lexical", "semantic", "hybrid"].includes(mode)) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
		const freshness = input.freshness ?? "allow-stale";
		if (mode === "semantic" && this.qmd.activity?.().embeddingActive) throw new DatastoreError("SEMANTIC_UNAVAILABLE", { retryable: true, requestedMode: mode });
		if (freshness !== "allow-stale" && !this.qmd.isLexicallyCurrent(store.name)) throw new DatastoreError("STALE_INDEX");
		{
			const backend = await this.qmd.search(store, input.query, mode, Math.min(500, Math.max(limit * 4, limit)), input.minScore, signal);
			if ((backend.effectiveMode === "semantic" || backend.effectiveMode === "hybrid") && (!backend.manifest.semanticAt || backend.manifest.pendingEmbeddings !== 0 || !backend.manifest.hasVectorIndex)) throw new DatastoreError("STALE_INDEX");
			if (backend.effectiveMode === "lexical" && freshness === "require-current-semantic") throw new DatastoreError("STALE_INDEX");
			const hits: SearchHit[] = []; let dropped = backend.rejectedCandidates ?? 0; let stale = dropped > 0;
			for (const candidate of backend.candidates) {
				if (hits.length >= limit) break;
				const indexed = backend.manifest.stores[store.name]?.[candidate.path];
				if (!indexed) { stale = true; dropped += 1; continue; }
				try {
					const source = await safeOpenNote(store, candidate.path, signal);
					if (source.fullRevision !== indexed.revision) { stale = true; dropped += 1; continue; }
					const parsed = parseMarkdown(source);
					const excerpt = input.includeContent ? this.excerpt(source.text, parsed, input.query, candidate) : undefined;
					hits.push({ note: source.note, uri: source.uri, path: source.note.path, title: parsed.title, snippet: excerpt?.content, rank: hits.length + 1, backendRank: candidate.backendRank, backend: "qmd" as const, mode: backend.effectiveMode, score: candidate.score, sourceRevision: source.revision, indexedRevision: source.revision, sourceMtime: source.mtime, indexFreshness: this.qmd.isLexicallyCurrent(store.name) ? "current" as const : "stale" as const, truncated: excerpt?.truncated ?? false });
				} catch (error) {
					if (error instanceof DatastoreError && (error.code === "CANCELLED" || error.code === "TIMEOUT")) throw error;
					stale = true; dropped += 1;
				}
			}
			if (stale && freshness !== "allow-stale") throw new DatastoreError("STALE_INDEX");
			const indexCurrent = this.qmd.isLexicallyCurrent(store.name);
			if (!indexCurrent && freshness !== "allow-stale") throw new DatastoreError("STALE_INDEX");
			const aggregateLines = (): number => Math.max(1, hits.reduce((count, hit) => count + (typeof hit.snippet === "string" ? lines(hit.snippet) : 1), 0)); let budgetTruncated = false; while (hits.length && (Buffer.byteLength(JSON.stringify(hits)) > this.config.defaults.maxResultBytes || aggregateLines() > this.config.defaults.maxResultLines)) { hits.pop(); budgetTruncated = true; }
			const text = JSON.stringify(hits); const returnedLines = aggregateLines(); if (Buffer.byteLength(text) > this.config.defaults.maxResultBytes || returnedLines > this.config.defaults.maxResultLines) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
			const staleMessage = "Serving indexed results while source reconciliation is pending; new notes may be absent.";
			const warnings = [...(backend.requestedMode !== backend.effectiveMode ? [{ code: "SEMANTIC_UNAVAILABLE" as const, message: "Embedding underway; semantic retrieval is temporarily unavailable. Hybrid request served with lexical search." }] : []), ...(!indexCurrent ? [{ code: "STALE_INDEX" as const, message: staleMessage }] : []), ...(dropped ? [{ code: "STALE_CANDIDATE_DROPPED" as const, message: "One or more backend candidates failed current direct validation." }] : []), ...(budgetTruncated ? [{ code: "RESULT_LIMIT_EXCEEDED" as const, message: "Search hits were truncated at the configured aggregate result budget." }] : [])];
			return this.envelope("search", store.name, { hits, examined: backend.candidates.length + (backend.rejectedCandidates ?? 0), dropped, returned: hits.length, requestedMode: backend.requestedMode, effectiveMode: backend.effectiveMode, queueMs: backend.queueMs, operationMs: backend.operationMs, workerId: backend.workerId }, started, text, budgetTruncated, undefined, [{ kind: "qmd", backendVersion: this.qmd.binding.version, observationId: backend.generation, observedAt: new Date().toISOString(), freshness: indexCurrent ? "current" : "stale" }, { kind: "filesystem", observedAt: new Date().toISOString(), freshness: "current" }], warnings, undefined, returnedLines) as SearchResult;
		}
	}

	private excerpt(text: string, parsed: ReturnType<typeof parseMarkdown>, query: string, candidate: QmdCandidate): { content: string; truncated: boolean } {
		let selected = "";
		if (!selected) {
			const terms = query.toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
			// Search results display body text, even when the backend matched metadata.
			const bodyStart = parsed.frontmatter.present ? parsed.frontmatter.endLine ?? parsed.lines.length : 0;
			const body = parsed.lines.slice(bodyStart).join("\n").replace(/^(?:[ \t]*\n)+/, "");
			const blocks = body.split(/\n{2,}/); selected = blocks.find((block) => terms.some((term) => block.toLocaleLowerCase("en-US").includes(term))) ?? blocks.find((block) => block.trim().length > 0) ?? "";
		}
		if (!selected) return { content: "", truncated: false };
		const page = boundedPage(selected, 0, Math.min(1024, this.config.defaults.maxResultBytes), Math.min(30, this.config.defaults.maxResultLines));
		return { content: page.content, truncated: page.truncated };
	}

	private async findInner(input: FindInput, signal: AbortSignal): Promise<FindResult> {
 const started=Date.now(),store=this.store(input.store);
 if(!Array.isArray(input.selectors)||!input.selectors.length||input.selectors.length>8)throw new DatastoreError("INVALID_NOTE_REF");
 const limit=input.limit??20;if(!Number.isInteger(limit)||limit<1||limit>20)throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
 const match=input.match??"all";if(!["all","any"].includes(match))throw new DatastoreError("INVALID_NOTE_REF");
 const notes=input.selectors.map(s=>{if(s.kind!=="uri" && (s.kind!=="path" || !s.path.endsWith(".md")))throw new DatastoreError("CAPABILITY_UNAVAILABLE");const note=s.kind==="uri"?noteUriToRef(s.uri):{store:store.name,path:validateRelativeNotePath(s.path)};if(note.store!==store.name)throw new DatastoreError("INVALID_NOTE_REF");return note;});
 const paths=[...new Set(notes.map(n=>n.path))];const candidates=[];
 for(const path of paths){if(match==="all" && paths.length>1)break;try{const source=await safeOpenNote(store,path,signal);candidates.push({note:source.note,uri:source.uri,title:parseMarkdown(source).title,revision:source.revision});}catch(error){propagateControlError(error);if(!(error instanceof DatastoreError)||error.code!=="NOTE_NOT_FOUND")throw error;}}
 const returned=candidates.slice(0,limit);let partial=candidates.length>limit;
 while(returned.length && Buffer.byteLength(JSON.stringify({candidates:returned,examined:paths.length,partial}))>this.config.defaults.maxResultBytes){returned.pop();partial=true;}
 const data={candidates:returned,examined:paths.length,partial};return this.envelope("find",store.name,data,started,JSON.stringify(data),partial,undefined,[{kind:"filesystem",observedAt:new Date().toISOString(),freshness:"current"}],[],undefined,Math.max(1,returned.length)) as FindResult;
 }

	private readDescriptor(input: ReadInput): { store: StoreConfig; descriptor: Omit<ContinuationDescriptor, "kind" | "revision" | "cursor" | "createdAt" | "expiresAt">; expectedRevision?: string; cursor: number } {
		if (input.continuation) {
			const existing = this.continuations.getRead(input.continuation);
			if (Object.keys(input).some((key) => key !== "continuation")) throw new DatastoreError("INVALID_NOTE_REF");
			return { store: this.store(existing.note.store), descriptor: existing, expectedRevision: existing.revision, cursor: existing.cursor };
		}
		if ((input.note === undefined) === (input.uri === undefined)) throw new DatastoreError("INVALID_NOTE_REF");
		const note = input.note ?? noteUriToRef(input.uri!);
		if (input.store && input.store !== note.store) throw new DatastoreError("INVALID_NOTE_REF");
		const store = this.store(note.store);
		const maxBytes = Math.min(input.maxBytes ?? this.config.defaults.maxResultBytes, HARD_MAX_RESULT_BYTES);
		const maxLines = Math.min(input.maxLines ?? this.config.defaults.maxResultLines, HARD_MAX_RESULT_LINES);
		if (!Number.isInteger(maxBytes) || maxBytes < 4 || !Number.isInteger(maxLines) || maxLines < 1) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
		const view = input.view ?? "content"; const hasHeading = input.headingPath !== undefined; const hasOccurrence = input.occurrence !== undefined; const hasSectionHandle = input.sectionHandle !== undefined; const hasExclusions = input.excludeSections !== undefined;
		const invalidOption = (option: "includeFrontmatter" | "headingPath" | "occurrence" | "sectionHandle" | "excludeSections" | "includeSemanticRelated"): never => { throw new DatastoreError("INVALID_NOTE_REF", { reason: "OPTION_NOT_ALLOWED", view, option }); };
		if (view === "section") {
			if (input.includeFrontmatter !== undefined) invalidOption("includeFrontmatter"); if (hasExclusions) invalidOption("excludeSections"); if (input.includeSemanticRelated !== undefined) invalidOption("includeSemanticRelated");
			if (hasSectionHandle === hasHeading || (hasOccurrence && !hasHeading)) throw new DatastoreError("INVALID_NOTE_REF");
		} else if (view === "content") {
			if (hasHeading) invalidOption("headingPath"); if (hasOccurrence) invalidOption("occurrence"); if (hasSectionHandle) invalidOption("sectionHandle"); if (input.includeSemanticRelated !== undefined) invalidOption("includeSemanticRelated");
		} else {
			if (hasHeading) invalidOption("headingPath"); if (hasOccurrence) invalidOption("occurrence"); if (hasSectionHandle) invalidOption("sectionHandle"); if (hasExclusions) invalidOption("excludeSections"); if (input.includeFrontmatter !== undefined) invalidOption("includeFrontmatter"); if (input.includeSemanticRelated !== undefined && view !== "related") invalidOption("includeSemanticRelated");
		}
		return { store, descriptor: { note, view, includeFrontmatter: input.includeFrontmatter ?? false, headingPath: input.headingPath, occurrence: input.occurrence, sectionHandle: input.sectionHandle, excludeSections: input.excludeSections ?? [], includeSemanticRelated: input.includeSemanticRelated ?? false, maxBytes, maxLines }, cursor: 0 };
	}

	private async readInner(input: ReadInput, signal: AbortSignal): Promise<ReadResult> {
		const started = Date.now(); throwIfAborted(signal);
		const { store, descriptor, expectedRevision, cursor } = this.readDescriptor(input);
		const source = await safeOpenNote(store, descriptor.note.path, signal);
		if (expectedRevision && expectedRevision !== source.fullRevision) throw new DatastoreError("STALE_CONTINUATION", { note: source.note });
		const parsed = parseMarkdown(source);
		if (["metadata","links","backlinks","related"].includes(descriptor.view)) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
 if(descriptor.view === "outline") {
 const outline=parsed.outline.slice(0,100).map(section=>({...section,handle:this.continuations.create({kind:"section",note:source.note,revision:source.fullRevision,headingPath:section.headingPath,occurrence:section.occurrence,startLine:section.startLine,endLine:section.endLine})}));
 const base={note:source.note,uri:source.uri,revision:source.revision,title:parsed.title};
 const bounded=boundedArrays(outline,[],"outline","unused",base,100,descriptor);const truncated=bounded.truncated||parsed.outline.length>100;
 const data={...base,outline:bounded.first};return this.envelope("read",store.name,data,started,JSON.stringify(data),truncated,undefined,[{kind:"filesystem",observedAt:new Date().toISOString(),freshness:"current"}],[],descriptor,bounded.returnedLines) as ReadResult;
 }
		let selected: string;
		let section: SectionDescriptor | undefined;
		if (descriptor.view === "section") {
			if (descriptor.sectionHandle) {
				const handle = this.continuations.getSection(descriptor.sectionHandle);
				if (handle.note.store !== source.note.store || handle.note.path !== source.note.path || handle.revision !== source.fullRevision) throw new DatastoreError("STALE_CONTINUATION", { note: source.note });
				section = selectSection(parsed, handle.headingPath, handle.occurrence);
			} else section = selectSection(parsed, descriptor.headingPath, descriptor.occurrence ?? 0);
			selected = sectionText(parsed, section);
		} else {
			selected = source.text;
			const exclusions: SectionDescriptor[] = [];
			for (const handleId of descriptor.excludeSections) {
				const handle = this.continuations.getSection(handleId);
				if (handle.note.store !== source.note.store || handle.note.path !== source.note.path || handle.revision !== source.fullRevision) throw new DatastoreError("STALE_CONTINUATION", { note: source.note });
				exclusions.push(selectSection(parsed, handle.headingPath, handle.occurrence));
			}
			if (exclusions.length) selected = contentWithoutSections(parsed, selected, exclusions);
			if (!descriptor.includeFrontmatter && parsed.frontmatter.present && parsed.frontmatter.endLine) selected = selected.split("\n").slice(parsed.frontmatter.endLine).join("\n");
		}
		throwIfAborted(signal);
		const page = boundedPage(selected, cursor, descriptor.maxBytes, descriptor.maxLines);
		const continuation = page.nextCursor === undefined ? undefined : this.continuations.create({ kind: "read", ...descriptor, revision: source.fullRevision, cursor: page.nextCursor });
		const data: Record<string, unknown> = { note: source.note, uri: source.uri, revision: source.revision, mtime: source.mtime, title: parsed.title, view: descriptor.view, content: page.content };
		if (section) data.section = section;
		if (parsed.frontmatter.error) data.diagnostics = [parsed.frontmatter.error];
		return this.envelope("read", store.name, data, started, page.content, page.truncated, continuation, [{ kind: "filesystem", observedAt: new Date().toISOString(), freshness: "current" }], [], descriptor) as ReadResult;
	}

	private async statusInner(input: StatusInput, signal: AbortSignal): Promise<StatusResult> {
		const started = Date.now(); throwIfAborted(signal);
		const stores = input.store ? [this.store(input.store)] : [...this.config.stores.values()];
		const statuses = []; let qmdStatus: Record<string, unknown> | undefined;
		if (this.qmd) { try { qmdStatus = await this.qmd.status(signal); } catch (error) { propagateControlError(error); qmdStatus = { state: "degraded", reasonCode: error instanceof DatastoreError ? error.code : "BACKEND_FAILED" }; } }
		const qmdActivity = this.qmd?.activity?.() ?? (qmdStatus?.reconciliation as ReturnType<QmdAdapter["activity"]> | undefined); const qmdJobs = qmdActivity?.jobs ?? [];
		const qmdSummary = qmdStatus ? Object.fromEntries(Object.entries(qmdStatus).filter(([key]) => !["stores", "refresh", "reconciliation"].includes(key))) : undefined;
		if (qmdSummary && qmdActivity) qmdSummary.refresh = { state: qmdActivity.state, active: qmdActivity.active, queued: qmdActivity.queued };
		for (const store of stores) {
			const cachedStore = qmdStatus?.stores && typeof qmdStatus.stores === "object" ? (qmdStatus.stores as Record<string, Record<string, unknown>>)[store.name] : undefined; const fileCount = typeof cachedStore?.documentCount === "number" ? cachedStore.documentCount : undefined; const directState = "ready" as const; const reasonCode = undefined;
			const runtimeCurrent = cachedStore?.runtimeLexicalCurrent === true; const qmdState = !this.config.qmd.enabled ? { state: "disabled" as const } : !this.qmd ? { state: "unavailable" as const, reasonCode: "BACKEND_MISSING" } : qmdStatus?.state === "ready" ? { state: "ready" as const, backend: "qmd" as const, version: this.qmd.binding.version, freshness: { state: runtimeCurrent ? "current" as const : "stale" as const } } : { state: "degraded" as const, backend: "qmd" as const, version: this.qmd.binding.version, reasonCode: String(qmdStatus?.reasonCode ?? "STALE_INDEX") };
			const semanticState = qmdState.state === "ready" && typeof qmdStatus?.semanticAt !== "string" ? { ...qmdState, state: "degraded" as const, reasonCode: "STALE_INDEX" } : qmdState;
			const permissionWarnings: string[] = []; const relevantJobs = qmdJobs.filter((job) => job.stores.includes(store.name)); const latest = relevantJobs[0]; const running = relevantJobs.find((job) => job.state === "running"); const queued = relevantJobs.find((job) => job.state === "queued"); const reconciliationState = runtimeCurrent ? "succeeded" : running ? "running" : queued ? "queued" : latest?.state === "failed" ? "failed" : latest?.state === "cancelled" ? "cancelled" : "pending";
			const reconciliation = { state: reconciliationState, additionsMayBeAbsent: !runtimeCurrent, sourceTraversalPerformed: false, job: running ?? queued ?? latest };
			statuses.push({ store: store.name, root: redactedRoot(store, this.config.projectRoot), rootWasSymlink: store.rootWasSymlink, fileCount, fileCountSource: fileCount === undefined ? "unavailable" : "backend-reported-count", permissionWarnings, sourceReconciliation: reconciliation, qmd: qmdSummary, capabilities: { direct: { state: directState, backend: "direct", exactPath: true, boundedContent: true, boundedSection: true, currentFileValidation: true, singleNoteFallbackLinks: false, reasonCode }, search: { lexical: qmdState, semantic: semanticState, hybrid: semanticState }, outline: {state:"ready",backend:"direct"}, mutations: { supported: false } } });
		}
		const data = { stores: statuses, enabled: true }; return this.envelope("status", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], undefined, Math.max(1, statuses.length)) as StatusResult;
	}

	private async refreshInner(input: RefreshInput, signal: AbortSignal): Promise<RefreshResult> {
		const started = Date.now(); throwIfAborted(signal);
		if (input.action === "cancel") {
			if (!this.qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE"); const qmd = await this.qmd.cancelRefresh(input.refreshId); const data = { action: "cancel", qmd, durationMs: elapsed(started) }; return this.envelope("refresh", "*", data, started, JSON.stringify(data), false, undefined, [], [], undefined, 1) as RefreshResult;
		}
		const mode = input.mode ?? "direct"; const stores = input.store ? [this.store(input.store)] : [...this.config.stores.values()];
		if (mode === "semantic" || mode === "all") {
			if (!this.qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE"); const qmd = await this.qmd.startSemanticRefresh(stores); const data = { action: "start", mode, qmd, backgroundOwnership: "explicit-maintenance", durationMs: elapsed(started) }; return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], undefined, 1) as RefreshResult;
		}
		if (mode === "lexical") { if (!this.qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE"); const qmd = await this.qmd.startLexicalRefresh(stores); const data = { action: "start", mode, qmd, backgroundOwnership: "explicit-maintenance", durationMs: elapsed(started) }; return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], undefined, 1) as RefreshResult; }
		const roots: Record<string, string> = {}; for (const store of stores) { const info = await lstat(store.root).catch(() => { throw new DatastoreError("STORE_UNAVAILABLE"); }); if (!info.isDirectory() || info.dev !== store.rootDev || info.ino !== store.rootIno) throw new DatastoreError("STORE_UNAVAILABLE"); roots[store.name] = "available"; }
		const data = { action: "start", mode, roots, semantics: "bounded-root-revalidation-only", durationMs: elapsed(started) }; return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], undefined, Math.max(1, Object.keys(roots).length)) as RefreshResult;
	}
	async shutdown(): Promise<void> {
		if (this.#closed) return; this.#closed = true; this.continuations.clear(); this.#lifecycle.abort(new DatastoreError("CANCELLED"));
		await Promise.allSettled([...this.#active, ...[this.qmd?.shutdown()].filter((operation): operation is Promise<void> => operation !== undefined)]);
	}
}
