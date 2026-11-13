import type {
	FindInput, FindResult, MarkdownDatastoreServiceV1, ReadInput, ReadResult, RefreshInput, RefreshResult,
	ResultEnvelope, SearchHit, SearchInput, SearchResult, StatusInput, StatusResult,
	RootsInput, RootsResult, DestinationInput, DestinationResult, MarkdownDatastorePolicyV1,
} from "./contract.ts";
import type { MarkdownDatastoreConfig, StoreConfig } from "./config.ts";
import { exceedsBudget, resolveResultBudget, type ResultBudget } from "./config-common.ts";
import { assertRootIdentity, inspectDestination, ownsDestination, noteUriToRef, redactedRoot, safeOpenNote, validateRelativeContainedPath, validateRelativeNotePath } from "./containment.ts";
import { ContinuationRegistry, type ContinuationDescriptor } from "./continuations.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import { boundedPage, contentWithoutSections, parseMarkdown, sectionText, selectSection, type SectionDescriptor } from "./markdown.ts";
import type { QmdAdapter, QmdCandidate } from "./qmd-adapter.ts";
import { SharedIndexClient } from "./shared-client.ts";
import type { MaintenanceCoordinator } from "./maintenance-coordinator.ts";
import type { IndexOwnership } from "./index-ownership.ts";
import { sourceDefinition } from "./maintenance-coordinator.ts";
import { continuationOffset, continuationToken, pageRendered, readPageToken, reconcileChanged, tagCandidate, type MetadataIndex } from "./metadata-index.ts";
import { tagIdentity } from "./wiki.ts";

function elapsed(started: number): number { return Math.max(0, Date.now() - started); }
function propagateControlError(error: unknown): void { if (error instanceof DatastoreError && (error.code === "CANCELLED" || error.code === "TIMEOUT")) throw error; }
function lines(value: string): number { return value.length === 0 ? 0 : value.split("\n").length; }
function boundedArrays(first: unknown[], second: unknown[], firstKey: string, secondKey: string, base: Record<string, unknown>, maximum: number, budget: ResultBudget): { first: unknown[]; second: unknown[]; text: string; returnedLines: number; truncated: boolean } {
	const selectedFirst: unknown[] = []; const selectedSecond: unknown[] = []; let truncated = false;
	for (const [target, items] of [[selectedFirst, first], [selectedSecond, second]] as const) for (const item of items) { const candidate = [...target, item]; const data = { ...base, [firstKey]: target === selectedFirst ? candidate : selectedFirst, [secondKey]: target === selectedSecond ? candidate : selectedSecond }; const text = JSON.stringify(data); if (selectedFirst.length + selectedSecond.length >= maximum || (budget.maxBytes !== null && Buffer.byteLength(text) > budget.maxBytes) || (budget.maxLines !== null && selectedFirst.length + selectedSecond.length + 1 > budget.maxLines)) { truncated = true; continue; } target.push(item); }
	const text = JSON.stringify({ ...base, [firstKey]: selectedFirst, [secondKey]: selectedSecond }); return { first: selectedFirst, second: selectedSecond, text, returnedLines: Math.max(1, selectedFirst.length + selectedSecond.length), truncated };
}

export class MarkdownDatastoreService implements MarkdownDatastoreServiceV1, MarkdownDatastorePolicyV1 {
	readonly config: MarkdownDatastoreConfig;
	readonly continuations: ContinuationRegistry;
	readonly qmd?: QmdAdapter;
	readonly sharedClients?: ReadonlyMap<string, SharedIndexClient>;
	metadata?: ReadonlyMap<string, MetadataIndex>;
	maintenance?: MaintenanceCoordinator;
	#ownership?: IndexOwnership;
	#lifecycle = new AbortController(); #active = new Set<Promise<unknown>>(); #closed = false;
	constructor(config: MarkdownDatastoreConfig, continuations = new ContinuationRegistry(), qmd?: QmdAdapter, sharedClients?: ReadonlyMap<string, SharedIndexClient>) { this.config = config; this.continuations = continuations; this.qmd = qmd; this.sharedClients = sharedClients; }
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
	roots(_input: RootsInput, signal?: AbortSignal): Promise<RootsResult> {
		return this.runOperation(signal, async activeSignal => {
			const started = Date.now();
			const roots = await this.policyRoots(activeSignal);
			return this.envelope("roots", "*", { roots }, started, JSON.stringify(roots), false, undefined, [], [], this.budget(_input));
		});
	}
	validateDestination(input: DestinationInput, signal?: AbortSignal): Promise<DestinationResult> {
		return this.runOperation(signal, async activeSignal => {
			const started = Date.now();
			await this.policyRoots(activeSignal);
			const path = await inspectDestination(input.path, activeSignal);
			const roots = await this.policyRoots(activeSignal);
			const stores = roots.filter(root => ownsDestination(root.path, path)).map(root => root.store);
			const data = { path, owned: stores.length > 0, stores };
			return this.envelope("validateDestination", "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input));
		});
	}
	private async policyRoots(signal: AbortSignal) {
		const roots = [];
		for (const store of this.config.stores.values()) {
			throwIfAborted(signal); await assertRootIdentity(store);
			roots.push({ store: store.name, path: store.root, device: store.rootDev, inode: store.rootIno });
		}
		throwIfAborted(signal);
		return roots;
	}
	private store(name: string | undefined): StoreConfig {
		if (!name) throw new DatastoreError("STORE_UNKNOWN");
		const store = this.config.stores.get(name);
		if (!store) throw new DatastoreError("STORE_UNKNOWN", { store: name });
		return store;
	}
	private budget(input?: object): ResultBudget { return resolveResultBudget(input as { maxBytes?: unknown; maxLines?: unknown } | undefined, { maxBytes: this.config.defaults.maxResultBytes ?? null, maxLines: this.config.defaults.maxResultLines ?? null }); }
	private envelope<T>(operation: ResultEnvelope<T>["operation"], store: string, data: T, started: number, text = "", truncated = false, continuation?: string, sources: ResultEnvelope<T>["provenance"]["sources"] = [], warnings: ResultEnvelope<T>["warnings"] = [], budget?: ResultBudget, measuredLines?: number, applied?: { operationApplied: true; refreshIds: string[] }): ResultEnvelope<T> {
		const effectiveBudget = budget ?? this.budget(); const returnedLines = measuredLines ?? lines(text); const completedAt = new Date().toISOString();
		let returnedBytes = 0; let result!: ResultEnvelope<T>;
		for (let attempt = 0; attempt < 4; attempt += 1) {
			result = { contractVersion: 1, operation, store, data, provenance: { sources, startedAt: new Date(started).toISOString(), completedAt, durationMs: elapsed(started) }, bounds: { maxBytes: effectiveBudget.maxBytes, maxLines: effectiveBudget.maxLines, returnedBytes, returnedLines, truncated, continuation }, warnings };
			const size = Buffer.byteLength(JSON.stringify(result));
			if (size === returnedBytes) break;
			returnedBytes = size;
		}
		if (exceedsBudget(JSON.stringify(result), { maxBytes: effectiveBudget.maxBytes, maxLines: null }) || (effectiveBudget.maxLines !== null && returnedLines > effectiveBudget.maxLines)) throw new DatastoreError("RESULT_LIMIT_EXCEEDED", applied);
		return result;
	}
	private async searchInner(input: SearchInput, signal: AbortSignal): Promise<SearchResult> {
		const started = Date.now(); throwIfAborted(signal); const store = this.store(input.store);
		const shared = store.shared ? this.sharedClients?.get(store.name) : undefined;
		if (store.shared && !shared) throw new DatastoreError("STORE_UNAVAILABLE");
		const qmd = this.qmd;
		if (!shared && !qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
		if (typeof input.query !== "string" || !input.query.trim() || Buffer.byteLength(input.query) > 4096) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
		const mode = input.mode ?? store.search.defaultMode; const limit = input.limit ?? 5;
		if (input.minScore !== undefined && !Number.isFinite(input.minScore)) throw new DatastoreError("INVALID_NOTE_REF");
		if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !["lexical", "semantic", "hybrid"].includes(mode)) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
		const freshness = input.freshness ?? "allow-stale";
		const embeddingActive = shared ? (await shared.activity(signal)).embeddingActive : Boolean(qmd!.activity?.().embeddingActive);
		const current = () => shared ? shared.isLexicallyCurrent(signal) : Promise.resolve(qmd!.isLexicallyCurrent(store.name));
		if (mode === "semantic" && embeddingActive) throw new DatastoreError("SEMANTIC_UNAVAILABLE", { retryable: true, requestedMode: mode });
		if (freshness !== "allow-stale" && !await current()) throw new DatastoreError("STALE_INDEX");
		const manifestName = store.shared?.store ?? store.name;
		const backendVersion = shared ? shared.version : qmd!.binding.version;
		{
			const backend = shared ? await shared.search(input.query, mode, Math.min(500, Math.max(limit * 4, limit)), input.minScore, signal) : await qmd!.search(store, input.query, mode, Math.min(500, Math.max(limit * 4, limit)), input.minScore, signal);
			if ((backend.effectiveMode === "semantic" || backend.effectiveMode === "hybrid") && (!backend.manifest.semanticAt || backend.manifest.pendingEmbeddings !== 0 || !backend.manifest.hasVectorIndex)) throw new DatastoreError("STALE_INDEX");
			if (backend.effectiveMode === "lexical" && freshness === "require-current-semantic") throw new DatastoreError("STALE_INDEX");
			const hits: SearchHit[] = []; let dropped = backend.rejectedCandidates ?? 0; let stale = dropped > 0;
			for (const candidate of backend.candidates) {
				if (hits.length >= limit) break;
				const indexed = backend.manifest.stores[manifestName]?.[candidate.path];
				if (!indexed) { stale = true; dropped += 1; continue; }
				try {
					const source = await safeOpenNote(store, candidate.path, signal);
					if (source.fullRevision !== indexed.revision) { stale = true; dropped += 1; continue; }
					const parsed = parseMarkdown(source);
					const excerpt = input.includeContent ? this.excerpt(source.text, parsed, input.query, candidate) : undefined;
					hits.push({ note: source.note, uri: source.uri, path: source.note.path, title: parsed.title, snippet: excerpt?.content, rank: hits.length + 1, backendRank: candidate.backendRank, backend: "qmd" as const, mode: backend.effectiveMode, score: candidate.score, sourceRevision: source.revision, indexedRevision: source.revision, sourceMtime: source.mtime, indexFreshness: await current() ? "current" as const : "stale" as const, truncated: excerpt?.truncated ?? false });
				} catch (error) {
					if (error instanceof DatastoreError && (error.code === "CANCELLED" || error.code === "TIMEOUT")) throw error;
					stale = true; dropped += 1;
				}
			}
			if (stale && freshness !== "allow-stale") throw new DatastoreError("STALE_INDEX");
			const indexCurrent = await current();
			if (!indexCurrent && freshness !== "allow-stale") throw new DatastoreError("STALE_INDEX");
			const budget = this.budget(input); const aggregateLines = (): number => Math.max(1, hits.reduce((count, hit) => count + (typeof hit.snippet === "string" ? lines(hit.snippet) : 1), 0)); let budgetTruncated = false; while (hits.length && exceedsBudget(JSON.stringify(hits), budget, aggregateLines())) { hits.pop(); budgetTruncated = true; }
			const text = JSON.stringify(hits); const returnedLines = aggregateLines(); if (exceedsBudget(text, budget, returnedLines)) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
			const staleMessage = "Serving indexed results while source reconciliation is pending; new notes may be absent.";
			const warnings = [...(backend.requestedMode !== backend.effectiveMode ? [{ code: "SEMANTIC_UNAVAILABLE" as const, message: "Embedding underway; semantic retrieval is temporarily unavailable. Hybrid request served with lexical search." }] : []), ...(!indexCurrent ? [{ code: "STALE_INDEX" as const, message: staleMessage }] : []), ...(dropped ? [{ code: "STALE_CANDIDATE_DROPPED" as const, message: "One or more backend candidates failed current direct validation." }] : []), ...(budgetTruncated ? [{ code: "RESULT_LIMIT_EXCEEDED" as const, message: "Search hits were truncated at the configured aggregate result budget." }] : [])];
			return this.envelope("search", store.name, { hits, examined: backend.candidates.length + (backend.rejectedCandidates ?? 0), dropped, returned: hits.length, requestedMode: backend.requestedMode, effectiveMode: backend.effectiveMode, queueMs: backend.queueMs, operationMs: backend.operationMs, workerId: backend.workerId }, started, text, budgetTruncated, undefined, [{ kind: "qmd", backendVersion, observationId: backend.generation, observedAt: new Date().toISOString(), freshness: indexCurrent ? "current" : "stale" }, { kind: "filesystem", observedAt: new Date().toISOString(), freshness: "current" }], warnings, this.budget(input), returnedLines) as SearchResult;
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
		const budget = this.budget(); const page = boundedPage(selected, 0, budget.maxBytes, budget.maxLines);
		return { content: page.content, truncated: page.truncated };
	}

	private async findInner(input: FindInput, signal: AbortSignal): Promise<FindResult> {
 const started=Date.now(),store=this.store(input.store);
 if(!Array.isArray(input.selectors)||!input.selectors.length||input.selectors.length>8)throw new DatastoreError("INVALID_NOTE_REF");
 const limit=input.limit??20;if(!Number.isInteger(limit)||limit<1||limit>20)throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
 const match=input.match??"all";if(!["all","any"].includes(match))throw new DatastoreError("INVALID_NOTE_REF");
 if (input.selectors.length === 1 && input.selectors[0].kind === "tag") {
  const query = tagIdentity(input.selectors[0].value);
  const budget = this.budget(input);
  const token = (input as { continuation?: string }).continuation;
  if (store.shared) {
   const client = this.sharedClients?.get(store.name); if (!client) throw new DatastoreError("STORE_UNAVAILABLE");
   const page = await client.tagPages(query, { continuation: token, limit, ...budget, responseStore: store.name }, signal);
   const data = { candidates: page.candidates, examined: page.examined, partial: page.continuation !== undefined };
   return this.envelope("find", store.name, data, started, JSON.stringify(data), page.continuation !== undefined, page.continuation, [{ kind: "filesystem", observedAt: new Date().toISOString(), freshness: page.complete ? "current" : "stale", indexRevision: page.revision }], [], budget) as FindResult;
  }
  const index = this.metadata?.get(store.name); if (!index) throw new DatastoreError("STALE_INDEX");
  const snapshot = await index.requireSnapshot();
  const pages = await index.tagPages(query);
  const offset = continuationOffset(token, store.name, snapshot.revision, query);
  const revisionOf = (path: string) => index.fileRevision(path, snapshot);
  if (pages.some((path) => !revisionOf(path))) throw new DatastoreError("STALE_INDEX");
  const selected = pageRendered(pages.slice(0, offset + limit), offset, budget, (page) => ({ candidates: page.map((path) => tagCandidate(store.name, path, revisionOf(path)!)), examined: pages.length, partial: offset + page.length < pages.length }));
  const bounded = selected.items.slice(0, limit);
  const admitted = await index.admit(store, bounded.map((path) => ({ path, kind: "note" as const })), signal);
  const next = offset + bounded.length < pages.length ? offset + bounded.length : undefined;
  const data = { candidates: bounded.map((path) => tagCandidate(store.name, path, revisionOf(path)!)), examined: pages.length, partial: next !== undefined };
  const warnings = admitted.diagnostics.map((message) => ({ code: "STALE_INDEX" as const, message }));
  return this.envelope("find", store.name, data, started, JSON.stringify(data), next !== undefined, next === undefined ? undefined : continuationToken(store.name, snapshot.revision, query, next, budget), [{ kind: "filesystem", observedAt: new Date().toISOString(), freshness: admitted.current ? "current" : "stale", indexRevision: snapshot.revision }], warnings, budget) as FindResult;
 }
 const notes=input.selectors.map(s=>{if(s.kind!=="uri" && (s.kind!=="path" || !s.path.endsWith(".md")))throw new DatastoreError("CAPABILITY_UNAVAILABLE");const note=s.kind==="uri"?noteUriToRef(s.uri):{store:store.name,path:validateRelativeNotePath(s.path)};if(note.store!==store.name)throw new DatastoreError("INVALID_NOTE_REF");return note;});
 const paths=[...new Set(notes.map(n=>n.path))];const candidates=[];
 for(const path of paths){if(match==="all" && paths.length>1)break;try{const source=await safeOpenNote(store,path,signal);candidates.push({note:source.note,uri:source.uri,title:parseMarkdown(source).title,revision:source.revision});}catch(error){propagateControlError(error);if(!(error instanceof DatastoreError)||error.code!=="NOTE_NOT_FOUND")throw error;}}
 const returned=candidates.slice(0,limit);let partial=candidates.length>limit;
 while(returned.length && exceedsBudget(JSON.stringify({candidates:returned,examined:paths.length,partial}), this.budget(input))){returned.pop();partial=true;}
 const data={candidates:returned,examined:paths.length,partial};return this.envelope("find",store.name,data,started,JSON.stringify(data),partial,undefined,[{kind:"filesystem",observedAt:new Date().toISOString(),freshness:"current"}],[],this.budget(input),Math.max(1,returned.length)) as FindResult;
 }

	private readDescriptor(input: ReadInput): { store: StoreConfig; descriptor: Omit<ContinuationDescriptor, "kind" | "revision" | "cursor" | "createdAt" | "expiresAt">; expectedRevision?: string; cursor: number } {
		if (input.continuation && Object.keys(input).every((key) => key === "continuation")) {
			try {
				const existing = this.continuations.getRead(input.continuation);
				return { store: this.store(existing.note.store), descriptor: existing, expectedRevision: existing.revision, cursor: existing.cursor };
			} catch (error) {
				if (!(error instanceof DatastoreError)) throw error;
				let parsed; try { parsed = readPageToken(input.continuation); } catch (decode) { if (/^[0-9a-f]{32}$/.test(input.continuation)) throw error; throw decode instanceof DatastoreError ? decode : new DatastoreError("STALE_CONTINUATION"); }
				const view = parsed.query.startsWith("links:") ? "links" : parsed.query.startsWith("backlinks:") ? "backlinks" : undefined;
				if (!view) throw new DatastoreError("STALE_CONTINUATION");
				let store; try { store = this.store(parsed.store); } catch (lookup) { if (lookup instanceof DatastoreError && lookup.code === "STORE_UNKNOWN") throw new DatastoreError("STALE_CONTINUATION"); throw lookup; }
				const budget = this.budget(parsed);
				return { store, descriptor: { note: { store: store.name, path: parsed.query.slice(view.length + 1) }, view, includeFrontmatter: false, excludeSections: [], includeSemanticRelated: false, ...budget }, cursor: 0 };
			}
		}
		if (input.continuation && (input.view === "links" || input.view === "backlinks")) {
			if (!input.note) throw new DatastoreError("INVALID_NOTE_REF");
			const budget = this.budget(input); return { store: this.store(input.note.store), descriptor: { note: input.note, view: input.view, includeFrontmatter: false, excludeSections: [], includeSemanticRelated: false, maxBytes: budget.maxBytes, maxLines: budget.maxLines }, cursor: 0 };
		}
		if (input.continuation) {
			const existing = this.continuations.getRead(input.continuation);
			if (Object.keys(input).some((key) => key !== "continuation" && key !== "maxBytes" && key !== "maxLines")) throw new DatastoreError("INVALID_NOTE_REF");
			const budget = this.budget({ maxBytes: input.maxBytes ?? existing.maxBytes, maxLines: input.maxLines ?? existing.maxLines });
			return { store: this.store(existing.note.store), descriptor: { ...existing, ...budget }, expectedRevision: existing.revision, cursor: existing.cursor };
		}
		if ((input.note === undefined) === (input.uri === undefined)) throw new DatastoreError("INVALID_NOTE_REF");
		const note = input.note ?? noteUriToRef(input.uri!);
		if (input.store && input.store !== note.store) throw new DatastoreError("INVALID_NOTE_REF");
		const store = this.store(note.store);
		const { maxBytes, maxLines } = this.budget(input);
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
		if (descriptor.view === "links" || descriptor.view === "backlinks") return this.metadataRead(store, descriptor.view, descriptor.note.path, started, signal, input.continuation, { maxBytes: descriptor.maxBytes, maxLines: descriptor.maxLines });
		const source = await safeOpenNote(store, descriptor.note.path, signal);
		if (expectedRevision && expectedRevision !== source.fullRevision) throw new DatastoreError("STALE_CONTINUATION", { note: source.note });
		const parsed = parseMarkdown(source);
		if (["metadata","related"].includes(descriptor.view)) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
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
		let byteCap = descriptor.maxBytes;
		for (let attempt = 0; attempt < 12; attempt += 1) {
			const page = boundedPage(selected, cursor, byteCap, descriptor.maxLines);
			const continuation = page.nextCursor === undefined ? undefined : this.continuations.create({ kind: "read", ...descriptor, revision: source.fullRevision, cursor: page.nextCursor });
			const data: Record<string, unknown> = { note: source.note, uri: source.uri, revision: source.revision, mtime: source.mtime, title: parsed.title, view: descriptor.view, content: page.content };
			if (section) data.section = section;
			if (parsed.frontmatter.error) data.diagnostics = [parsed.frontmatter.error];
			try { return this.envelope("read", store.name, data, started, page.content, page.truncated, continuation, [{ kind: "filesystem", observedAt: new Date().toISOString(), freshness: "current" }], [], descriptor) as ReadResult; }
			catch (error) {
				if (!(error instanceof DatastoreError) || error.code !== "RESULT_LIMIT_EXCEEDED" || byteCap === null || page.content.length === 0) throw error;
				byteCap = Math.max(1, Math.floor(Buffer.byteLength(page.content) / 2));
			}
		}
		throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
	}

	private localReceipt<T extends object>(value: T, store: StoreConfig): T {
		const stores = "stores" in value ? value.stores : undefined;
		if (!store.shared || !Array.isArray(stores)) return value;
		return { ...value, stores: stores.map(name => name === store.shared!.store ? store.name : name) };
	}

	private async statusInner(input: StatusInput, signal: AbortSignal): Promise<StatusResult> {
		const started = Date.now(); throwIfAborted(signal);
		const stores = input.store ? [this.store(input.store)] : [...this.config.stores.values()];
		const statuses = []; let qmdStatus: Record<string, unknown> | undefined;
		if (this.qmd) { try { qmdStatus = await this.qmd.status(signal); } catch (error) { propagateControlError(error); qmdStatus = { state: "degraded", reasonCode: error instanceof DatastoreError ? error.code : "BACKEND_FAILED" }; } }
		for (const store of stores) {
			let backendStatus = qmdStatus;
			let qmdActivity = this.qmd?.activity?.() ?? (qmdStatus?.reconciliation as ReturnType<QmdAdapter["activity"]> | undefined);
			let enabled = this.config.qmd.enabled, available = Boolean(this.qmd), version = this.qmd?.binding.version, canonicalName = store.name;
			if (store.shared) {
				const client = this.sharedClients?.get(store.name);
				enabled = true; available = Boolean(client); canonicalName = store.shared.store;
				if (!client) backendStatus = { state: "unavailable", reasonCode: "STORE_UNAVAILABLE" };
				else { try { backendStatus = await client.status(signal); } catch (error) { propagateControlError(error); backendStatus = { state: "unavailable", reasonCode: error instanceof DatastoreError ? error.code : "STORE_UNAVAILABLE" }; } }
				version = client?.version;
				qmdActivity = backendStatus?.refresh as ReturnType<QmdAdapter["activity"]> | undefined;
			}
			const qmdJobs = (qmdActivity?.jobs ?? []).map(job => this.localReceipt(job, store));
			const qmdSummary = backendStatus ? Object.fromEntries(Object.entries(backendStatus).filter(([key]) => !["stores", "refresh", "reconciliation"].includes(key))) : undefined;
			if (qmdSummary && qmdActivity) qmdSummary.refresh = { state: qmdActivity.state, active: qmdActivity.active, queued: qmdActivity.queued };
			const cachedStore = backendStatus?.stores && typeof backendStatus.stores === "object" ? (backendStatus.stores as Record<string, Record<string, unknown>>)[canonicalName] : undefined; const fileCount = typeof cachedStore?.documentCount === "number" ? cachedStore.documentCount : undefined; const directState = "ready" as const; const reasonCode = undefined;
			const qmdState = !enabled ? { state: "disabled" as const } : !available || backendStatus?.state === "unavailable" ? { state: "unavailable" as const, reasonCode: String(backendStatus?.reasonCode ?? (store.shared ? "STORE_UNAVAILABLE" : "BACKEND_MISSING")) } : backendStatus?.state === "ready" ? { state: "ready" as const, backend: "qmd" as const, version, freshness: { state: cachedStore?.runtimeLexicalCurrent === true ? "current" as const : "stale" as const } } : { state: "degraded" as const, backend: "qmd" as const, version, reasonCode: String(backendStatus?.reasonCode ?? "STALE_INDEX") };
			const runtimeCurrent = cachedStore?.runtimeLexicalCurrent === true;
			const semanticState = qmdState.state === "ready" && typeof backendStatus?.semanticAt !== "string" ? { ...qmdState, state: "degraded" as const, reasonCode: "STALE_INDEX" } : qmdState;
			const localSnapshot = store.shared ? undefined : await this.metadata?.get(store.name)?.snapshot();
			await this.maintenance?.ensureLoaded();
			const metadataJobs = (this.maintenance?.jobs() ?? []).filter((job) => job.mode === "metadata" && job.stores.includes(store.name));
			const metadataRunning = metadataJobs.find((job) => job.state === "running");
			const metadataQueued = metadataJobs.find((job) => job.state === "queued");
			const sharedMetadata = backendStatus?.metadata as { state?: string; revision?: string; complete?: boolean; progress?: { state: string; active: boolean; queued: boolean; job?: unknown } } | undefined;
			const metadata = store.shared ? sharedMetadata ?? { state: "unavailable", complete: false, progress: { state: "idle", active: false, queued: false } } : { state: !localSnapshot ? "unavailable" : localSnapshot.complete ? "ready" : "stale", revision: localSnapshot?.revision, complete: localSnapshot?.complete ?? false, progress: { state: metadataRunning ? "running" : metadataQueued ? "queued" : "idle", active: Boolean(metadataRunning), queued: Boolean(metadataQueued), job: metadataRunning ?? metadataQueued ?? metadataJobs[0] } };
			const permissionWarnings: string[] = []; const relevantJobs = qmdJobs.filter((job) => job.stores.includes(store.name)); const latest = relevantJobs[0]; const running = relevantJobs.find((job) => job.state === "running"); const queued = relevantJobs.find((job) => job.state === "queued"); const reconciliationState = runtimeCurrent ? "succeeded" : running ? "running" : queued ? "queued" : latest?.state === "failed" ? "failed" : latest?.state === "cancelled" ? "cancelled" : "pending";
			const reconciliation = { state: reconciliationState, additionsMayBeAbsent: !runtimeCurrent, sourceTraversalPerformed: false, job: running ?? queued ?? latest };
			statuses.push({ store: store.name, root: redactedRoot(store, this.config.projectRoot), rootWasSymlink: store.rootWasSymlink, fileCount, fileCountSource: fileCount === undefined ? "unavailable" : "backend-reported-count", permissionWarnings, sourceReconciliation: reconciliation, qmd: qmdSummary, capabilities: { direct: { state: directState, backend: "direct", exactPath: true, boundedContent: true, boundedSection: true, currentFileValidation: true, singleNoteFallbackLinks: false, reasonCode }, search: { lexical: qmdState, semantic: semanticState, hybrid: semanticState }, outline: {state:"ready",backend:"direct"}, metadata, mutations: { supported: false } } });
		}
		const data = { stores: statuses, enabled: true }; return this.envelope("status", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), Math.max(1, statuses.length)) as StatusResult;
	}

	private async refreshInner(input: RefreshInput, signal: AbortSignal): Promise<RefreshResult> {
		if (Object.hasOwn(input, "paths") && (input.action === "cancel" || input.mode !== "metadata")) throw new DatastoreError("INVALID_NOTE_REF");
		const started = Date.now(); throwIfAborted(signal);
		if (input.action === "cancel") {
			const qmd = await this.cancelRefresh(input.refreshId, signal); const data = { action: "cancel", qmd, durationMs: elapsed(started) }; return this.envelope("refresh", "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), 1, { operationApplied: true, refreshIds: [String((data as { qmd?: { refreshId?: string } }).qmd?.refreshId ?? "")] }) as RefreshResult;
		}
		const mode = input.mode ?? "direct"; const stores = input.store ? [this.store(input.store)] : [...this.config.stores.values()];
		if (mode === "metadata" || mode === "rebuild") {
			if (input.paths !== undefined && mode !== "metadata") throw new DatastoreError("INVALID_NOTE_REF");
			if (mode === "metadata" && input.paths !== undefined) { if (!Array.isArray(input.paths) || input.paths.length === 0) throw new DatastoreError("INVALID_NOTE_REF"); for (const path of input.paths) validateRelativeContainedPath(path); }
			const local = stores.filter((store) => !store.shared).map((store) => store.name);
			if (mode === "metadata" && input.paths?.length) for (const name of local) this.maintenance?.notePaths(name, input.paths);
			const shared = stores.filter((store) => store.shared);
			if (!local.length && !shared.length) throw new DatastoreError("STORE_UNKNOWN");
			const receipt = local.length ? await this.maintenance?.enqueue("metadata", local, "explicit-maintenance", sourceDefinition(local.map((name) => this.store(name))), mode === "rebuild" || input.paths === undefined ? "rebuild" : undefined) : undefined;
			if (local.length && !receipt) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
			const sharedReceipts = [];
			for (const store of shared) {
				const client = this.sharedClients?.get(store.name);
				if (!client) throw new DatastoreError("STORE_UNAVAILABLE");
				sharedReceipts.push(await client.startMetadata(signal, mode === "metadata" ? input.paths : undefined, mode === "rebuild" || input.paths === undefined));
			}
			const data = { action: "start", mode, qmd: receipt ?? sharedReceipts[0], shared: sharedReceipts, backgroundOwnership: "explicit-maintenance", durationMs: elapsed(started) };
			const refreshIds = [receipt, ...sharedReceipts].map((item) => (item as { refreshId?: string } | undefined)?.refreshId).filter((id): id is string => typeof id === "string");
			return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), 1, { operationApplied: true, refreshIds }) as RefreshResult;
		}
		const sharedStores = stores.filter((store) => store.shared);
		if (sharedStores.length && (mode === "lexical" || mode === "semantic" || mode === "all")) {
			const receipts = [];
			for (const store of sharedStores) {
				const client = this.sharedClients?.get(store.name);
				if (!client) throw new DatastoreError("STORE_UNAVAILABLE");
				receipts.push(this.localReceipt(mode === "lexical" ? await client.startLexical(signal) : await client.startSemantic(signal), store));
			}
				if (sharedStores.length === stores.length) {
				const data = { action: "start", mode, qmd: receipts[0], shared: receipts, backgroundOwnership: "explicit-maintenance", durationMs: elapsed(started) };
				return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), 1, { operationApplied: true, refreshIds: [String((data as { qmd?: { refreshId?: string } }).qmd?.refreshId ?? "")] }) as RefreshResult;
			}
			const privateStores = stores.filter((store) => !store.shared);
			if (!this.qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
			const qmd = mode === "lexical" ? await this.qmd.startLexicalRefresh(privateStores) : await this.qmd.startSemanticRefresh(privateStores);
			const data = { action: "start", mode, qmd, shared: receipts, backgroundOwnership: "explicit-maintenance", durationMs: elapsed(started) };
			return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), 1, { operationApplied: true, refreshIds: [String((data as { qmd?: { refreshId?: string } }).qmd?.refreshId ?? "")] }) as RefreshResult;
		}
		if (mode === "semantic" || mode === "all") {
			if (!this.qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE"); const qmd = await this.qmd.startSemanticRefresh(stores); const data = { action: "start", mode, qmd, backgroundOwnership: "explicit-maintenance", durationMs: elapsed(started) }; return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), 1, { operationApplied: true, refreshIds: [String((data as { qmd?: { refreshId?: string } }).qmd?.refreshId ?? "")] }) as RefreshResult;
		}
		if (mode === "lexical") { if (!this.qmd) throw new DatastoreError("CAPABILITY_UNAVAILABLE"); const qmd = await this.qmd.startLexicalRefresh(stores); const data = { action: "start", mode, qmd, backgroundOwnership: "explicit-maintenance", durationMs: elapsed(started) }; return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), 1, { operationApplied: true, refreshIds: [String((data as { qmd?: { refreshId?: string } }).qmd?.refreshId ?? "")] }) as RefreshResult; }
		const roots: Record<string, string> = {}; for (const store of stores) { await assertRootIdentity(store); roots[store.name] = "available"; }
		const data = { action: "start", mode, roots, semantics: "bounded-root-revalidation-only", durationMs: elapsed(started) }; return this.envelope("refresh", input.store ?? "*", data, started, JSON.stringify(data), false, undefined, [], [], this.budget(input), Math.max(1, Object.keys(roots).length)) as RefreshResult;
	}
	private async cancelRefresh(refreshId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
		if (this.qmd) {
			try { return await this.qmd.cancelRefresh(refreshId); } catch (error) { if (!(error instanceof DatastoreError) || error.code !== "INVALID_NOTE_REF") throw error; }
		}
		for (const [name, client] of this.sharedClients?.entries() ?? []) {
			try { return this.localReceipt(await client.cancel(refreshId, signal), this.store(name)); } catch (error) { if (!(error instanceof DatastoreError) || error.code !== "INVALID_NOTE_REF") throw error; }
		}
		if (this.maintenance) {
			try { return await this.maintenance.cancel(refreshId); } catch (error) { if (!(error instanceof DatastoreError) || error.code !== "INVALID_NOTE_REF") throw error; }
		}
		throw new DatastoreError(this.qmd || this.sharedClients?.size || this.maintenance ? "INVALID_NOTE_REF" : "CAPABILITY_UNAVAILABLE");
	}
	bindMetadata(coordinator: MaintenanceCoordinator, indexes: Map<string, MetadataIndex>, ownership?: IndexOwnership): void { this.maintenance = coordinator; this.metadata = indexes; this.#ownership = ownership; coordinator.startCycle(() => reconcileChanged(coordinator, indexes, this.config.stores)); }
	private async metadataRead(store: StoreConfig, view: "links" | "backlinks", path: string, started: number, signal: AbortSignal, token?: string, budget = this.budget()): Promise<ReadResult> {
		throwIfAborted(signal);
		if (store.shared) {
			const client = this.sharedClients?.get(store.name);
			if (!client) throw new DatastoreError("STORE_UNAVAILABLE");
			const page = view === "links" ? await client.links(path, { continuation: token, ...budget, responseStore: store.name }, signal) : await client.backlinks(path, { continuation: token, ...budget, responseStore: store.name }, signal);
			const data = { note: { store: store.name, path }, view, edges: page.edges, pageCount: page.pageCount, occurrenceCount: page.occurrenceCount, returned: page.returned, complete: page.complete, revision: page.revision };
			const warnings = (page.diagnostics ?? []).map((message) => ({ code: "STALE_INDEX" as const, message }));
			return this.envelope("read", store.name, data, started, JSON.stringify(data), page.continuation !== undefined, page.continuation, [{ kind: "filesystem", observedAt: new Date().toISOString(), freshness: page.complete ? "current" : "stale" }], warnings) as ReadResult;
		}
		const index = this.metadata?.get(store.name);
		if (!index) throw new DatastoreError("STALE_INDEX");
		const snapshot = await index.requireSnapshot();
		const query = `${view}:${path}`;
		const edges = view === "links" ? await index.links(path) : await index.backlinks(path);
		const offset = continuationOffset(token, store.name, snapshot.revision, query);
		const pageCount = new Set(edges.map((edge) => view === "links" ? edge.target : edge.source)).size;
		const render = (items: typeof edges) => ({ note: { store: store.name, path }, view, edges: items, pageCount, occurrenceCount: edges.length, returned: items.length, complete: snapshot.complete, revision: snapshot.revision });
		const page = pageRendered(edges, offset, budget, render);
		const subject = { path, kind: view === "backlinks" && !path.endsWith(".md") ? "attachment" as const : "note" as const };
		const admitted = await index.admit(store, [subject, ...page.items.flatMap((edge) => [{ path: edge.source, kind: "note" as const }, ...(edge.targetKind === "note" || edge.targetKind === "attachment" ? [{ path: edge.target, kind: edge.targetKind }] : [])])], signal);
		const data = { ...render(page.items), complete: admitted.current };
		const warnings = admitted.diagnostics.map((message) => ({ code: "STALE_INDEX" as const, message }));
		return this.envelope("read", store.name, data, started, JSON.stringify(data), page.next !== undefined, page.next === undefined ? undefined : continuationToken(store.name, snapshot.revision, query, page.next, budget), [{ kind: "filesystem", observedAt: new Date().toISOString(), freshness: admitted.current ? "current" : "stale" }], warnings) as ReadResult;
	}
	async tags(input: { store: string; continuation?: string; maxBytes?: number; maxLines?: number }, signal?: AbortSignal): Promise<RefreshResult> {
		return this.runOperation(signal, async (active) => {
			throwIfAborted(active);
			const started = Date.now();
			const store = this.store(input.store);
			const budget = this.budget(input);

			const query = "catalog";
			if (store.shared) {
				const client = this.sharedClients?.get(store.name); if (!client) throw new DatastoreError("STORE_UNAVAILABLE");
				const page = await client.tags({ continuation: input.continuation, ...budget, responseStore: store.name }, signal);
				const data = { tags: page.tags, revision: page.revision, returned: page.returned, total: page.total };
				return this.envelope("tags", store.name, data, started, JSON.stringify(data), page.continuation !== undefined, page.continuation) as RefreshResult;
			}
			const index = this.metadata?.get(store.name);
			if (!index) throw new DatastoreError("STALE_INDEX");
			const snapshot = await index.requireSnapshot();
			const offset = continuationOffset(input.continuation, store.name, snapshot.revision, query);
			const catalog = await index.catalog();
			const render = (items: typeof catalog) => ({ tags: items.map((tag) => ({ identity: tag.identity, spelling: tag.spelling, pageCount: tag.pages.length })), revision: snapshot.revision, returned: items.length, total: catalog.length });
			const page = pageRendered(catalog, offset, budget, render);
			const admitted = await index.admit(store, [], active);
			const data = render(page.items);
			const continuation = page.next === undefined ? undefined : continuationToken(store.name, snapshot.revision, query, page.next, budget);
			const warnings = admitted.diagnostics.map((message) => ({ code: "STALE_INDEX" as const, message }));
			return this.envelope("tags", store.name, data, started, JSON.stringify(data), page.next !== undefined, continuation, [], warnings) as RefreshResult;
		});
	}
	async shutdown(): Promise<void> {
		if (this.#closed) return; this.#closed = true; this.continuations.clear(); this.#lifecycle.abort(new DatastoreError("CANCELLED"));
		this.maintenance?.shutdown();
		await Promise.allSettled([...this.#active, this.maintenance?.settled(), ...[this.qmd?.shutdown(), ...[...this.sharedClients?.values() ?? []].map((client) => client.shutdown())].filter((operation): operation is Promise<void> => operation !== undefined)]);
		await this.#ownership?.release();
	}
}
