import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	MARKDOWN_DATASTORE_CONTRACT_VERSION, MARKDOWN_DATASTORE_REQUEST_EVENT,
	MARKDOWN_DATASTORE_CAPABILITY_REQUEST, MARKDOWN_DATASTORE_CAPABILITY_REPLY,
	type MarkdownDatastoreCapabilityRequest, type MarkdownDatastoreCapability,
	type MarkdownDatastoreRequest, type MarkdownDatastoreResult, type MarkdownDatastoreRpcEnvelope,
	type ReadInput, type RefreshInput,
} from "./contract.ts";
import { HARD_MAX_RESULT_BYTES, HARD_MAX_RESULT_LINES, loadMarkdownDatastoreConfig, projectDatastoreConfigPath } from "./config.ts";
import { DatastoreError, datastoreError } from "./errors.ts";
import { discoverQmdBinding, QmdAdapter } from "./qmd-adapter.ts";
import { MarkdownDatastoreService } from "./service.ts";

export interface MarkdownDatastoreExtensionOptions {
	projectRoot?: string; configPath?: string;
	createQmd?: typeof createQmd;
}
async function createQmd(config: Awaited<ReturnType<typeof loadMarkdownDatastoreConfig>>): Promise<QmdAdapter> { return new QmdAdapter(config, await discoverQmdBinding(config)); }

const Note = Type.Object({ store: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }), path: Type.String({ minLength: 3 }) }, { additionalProperties: false });
const Selector = Type.Union([
	Type.Object({ kind: StringEnum(["path"] as const), path: Type.String() }, { additionalProperties: false }),
	Type.Object({ kind: StringEnum(["uri"] as const), uri: Type.String() }, { additionalProperties: false }),
]);
const ReadIdentity = { store: Type.Optional(Type.String()), note: Type.Optional(Note), uri: Type.Optional(Type.String()) };
const ReadBounds = { maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: HARD_MAX_RESULT_BYTES })), maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_RESULT_LINES })) };
const forbidden = (...keys: string[]) => ({ not: { anyOf: keys.map((key) => ({ required: [key] })) } });
const Schemas = {
	search: Type.Object({ store: Type.String(), query: Type.String({ minLength: 1, maxLength: 4096 }), mode: Type.Optional(StringEnum(["lexical", "semantic", "hybrid"] as const)), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), minScore: Type.Optional(Type.Number()), freshness: Type.Optional(StringEnum(["allow-stale", "require-current-lexical", "require-current-semantic"] as const)), includeContent: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
	find: Type.Object({ store: Type.String(), selectors: Type.Array(Selector, { minItems: 1, maxItems: 8 }), match: Type.Optional(StringEnum(["all", "any"] as const)), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
	read: Type.Unsafe<ReadInput>({
		type: "object",
		properties: {
			continuation: Type.String(), ...ReadIdentity,
			view: StringEnum(["content", "section", "outline"] as const),
			includeFrontmatter: Type.Boolean(), excludeSections: Type.Array(Type.String(), { maxItems: 20 }),
			headingPath: Type.Array(Type.String(), { minItems: 1, maxItems: 12 }), occurrence: Type.Integer({ minimum: 0 }), sectionHandle: Type.String(),
			...ReadBounds,
		},
		additionalProperties: false,
		anyOf: [
			{ required: ["continuation"], ...forbidden("store", "note", "uri", "view", "includeFrontmatter", "excludeSections", "headingPath", "occurrence", "sectionHandle", "includeSemanticRelated", "maxBytes", "maxLines") },
			{ properties: { view: { type: "string", enum: ["content"] } }, ...forbidden("continuation", "headingPath", "occurrence", "sectionHandle", "includeSemanticRelated") },
			{ required: ["view"], properties: { view: { type: "string", enum: ["section"] } }, ...forbidden("continuation", "includeFrontmatter", "excludeSections", "includeSemanticRelated") },
			{ required: ["view"], properties: { view: { type: "string", enum: ["outline"] } }, ...forbidden("continuation", "includeFrontmatter", "excludeSections", "headingPath", "occurrence", "sectionHandle", "includeSemanticRelated") },
		],
	}),
	status: Type.Object({ store: Type.Optional(Type.String()) }, { additionalProperties: false }),
	refresh: Type.Unsafe<RefreshInput>({
		type: "object",
		properties: {
			action: { type: "string", enum: ["start", "cancel"], description: "Start derived-state maintenance, or cancel one lexical or semantic job." },
			store: { type: "string", description: "Configured store to refresh. Valid only for start; omit to refresh all stores." },
			mode: { type: "string", enum: ["direct", "lexical", "semantic", "all"], description: "Derived state to refresh. Valid only for start." },
			refreshId: { type: "string", pattern: "^[0-9a-f]{32}$", description: "Lexical or semantic job ID returned by a prior start. Required only for cancel." },
		},
		additionalProperties: false,
		anyOf: [
			{ properties: { action: { type: "string", enum: ["start"] } }, not: { required: ["refreshId"] } },
			{ required: ["action", "refreshId"], properties: { action: { type: "string", enum: ["cancel"] } }, not: { anyOf: [{ required: ["store"] }, { required: ["mode"] }] } },
		],
	}),
};
function checkSchema(schema: any, value: unknown): boolean {
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some((member: unknown) => checkSchema(member, value))) return false;
	if (schema.not && checkSchema(schema.not, value)) return false;
	if (schema.type === "null") return value === null;
	if (schema.type === "boolean") return typeof value === "boolean";
	if (schema.type === "number" || schema.type === "integer") return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
	if (schema.type === "string") return typeof value === "string" && (schema.minLength === undefined || value.length >= schema.minLength) && (schema.maxLength === undefined || value.length <= schema.maxLength) && (schema.pattern === undefined || new RegExp(schema.pattern, "u").test(value));
	if (schema.type === "array") return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && value.every((item) => checkSchema(schema.items, item));
	if (schema.type === "object" || schema.properties || schema.required || schema.additionalProperties === false) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const properties = schema.properties ?? {};
		if (schema.additionalProperties === false && !exactKeys(value, Object.keys(properties))) return false;
		if ((schema.required ?? []).some((key: string) => !(key in value))) return false;
		return Object.entries(value).every(([key, item]) => !(key in properties) || checkSchema(properties[key], item));
	}
	return true;
}
const claimedRpcEnvelopes = new WeakSet<object>();
function exactKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function validRpcRequest(value: unknown): value is MarkdownDatastoreRequest {
	if (!exactKeys(value, ["operation", "input"]) || Object.keys(value).length !== 2 || typeof value.operation !== "string" || !(value.operation in Schemas)) return false;
	return checkSchema(Schemas[value.operation as keyof typeof Schemas], value.input);
}

function toolText(result: MarkdownDatastoreResult): string {
	const serialized = JSON.stringify(result);
	const bounded = truncateHead(serialized, { maxBytes: HARD_MAX_RESULT_BYTES, maxLines: HARD_MAX_RESULT_LINES });
	return bounded.truncated ? `${bounded.content}\n[RESULT_LIMIT_EXCEEDED: structured result truncated at the datastore hard ceiling]` : bounded.content;
}

export function createMarkdownDatastoreExtension(options: MarkdownDatastoreExtensionOptions = {}) {
	const projectRoot = resolve(options.projectRoot ?? process.cwd());
	const configPath = resolve(options.configPath ?? projectDatastoreConfigPath(projectRoot));
	return function markdownDatastoreExtension(pi: ExtensionAPI): void {
		let service: MarkdownDatastoreService | undefined; let registered = false; let rpcUnsubscribe: (() => void) | undefined; let generation = 0;
		const subscribeCapability = () => pi.events.on(MARKDOWN_DATASTORE_CAPABILITY_REQUEST, (payload) => {
			const request = payload as Partial<MarkdownDatastoreCapabilityRequest> | null;
			if (!request || request.version !== 1 || typeof request.requestId !== "string" || request.requestId.length < 1 || request.requestId.length > 128) return;
			const ownGeneration = generation;
			const capability: MarkdownDatastoreCapability = {
				version: 1, contractVersion: MARKDOWN_DATASTORE_CONTRACT_VERSION,
				get ready() { return generation === ownGeneration && service !== undefined; },
				get stores() { return generation === ownGeneration && service ? [...service.config.stores.keys()] : []; },
			};
			pi.events.emit(MARKDOWN_DATASTORE_CAPABILITY_REPLY, { version: 1, requestId: request.requestId, capability });
		});
		let capabilityUnsubscribe: (() => void) | undefined = subscribeCapability();
		const observe = (operation: string, store: string | undefined, phase: "start" | "end", started: number, fields: Record<string, unknown> = {}): void => {
			pi.appendEntry("markdown-datastore-operation", { version: 1, operation, store, phase, durationMs: phase === "end" ? Math.max(0, Date.now() - started) : undefined, timestamp: new Date().toISOString(), ...fields });
		};
		const structuralMetrics = (result: MarkdownDatastoreResult): Record<string, unknown> => {
			const data = result.data as Record<string, unknown>; let candidateCount: number | undefined; let returnedCount: number | undefined; let refreshCount: number | undefined;
			if (result.operation === "search") { candidateCount = Number(data.examined); returnedCount = Number(data.returned); }
			else if (result.operation === "find") { returnedCount = Array.isArray(data.candidates) ? data.candidates.length : 0; candidateCount = typeof data.examined === "number" && Number.isInteger(data.examined) && data.examined >= 0 ? data.examined : undefined; }
			else if (result.operation === "read") { const arrays = ["outline", "edges", "links", "backlinks", "embeds"].map((key) => data[key]).filter(Array.isArray); returnedCount = arrays.length ? arrays.reduce((count, items) => count + items.length, 0) : 1; }
			else if (result.operation === "status") returnedCount = Array.isArray(data.stores) ? data.stores.length : 0;
			else if (result.operation === "refresh") { const counts = data.counts && typeof data.counts === "object" ? Object.values(data.counts as Record<string, unknown>).filter((value): value is number => typeof value === "number" && Number.isFinite(value)) : []; const roots = data.roots && typeof data.roots === "object" ? Object.keys(data.roots as Record<string, unknown>) : []; refreshCount = counts.length ? counts.reduce((sum, value) => sum + value, 0) : roots.length || (data.qmd ? 1 : 0); returnedCount = counts.length || roots.length || (data.qmd ? 1 : 0); }
			const statusStores = result.operation === "status" && Array.isArray(data.stores) ? data.stores.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : []; const qmdStatuses = statusStores.map((item) => item.qmd).filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null); const backendSelection = [...new Set(result.provenance.sources.map((source) => source.kind))]; if ((result.operation === "status" || result.operation === "refresh") && !backendSelection.includes("filesystem")) backendSelection.push("filesystem"); if ((data.qmd || qmdStatuses.length) && !backendSelection.includes("qmd")) backendSelection.push("qmd"); const freshnessStates = [...new Set(result.provenance.sources.map((source) => source.freshness))]; const reconciliationStates = statusStores.map((item) => item.sourceReconciliation).filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null).map((item) => item.state); if (qmdStatuses.some((item) => item.state === "ready") && reconciliationStates.length > 0 && reconciliationStates.every((state) => state === "succeeded") && !freshnessStates.includes("current")) freshnessStates.push("current"); else if (qmdStatuses.some((item) => item.state === "ready") && !freshnessStates.includes("stale")) freshnessStates.push("stale"); const processExitCategories = result.operation === "refresh" ? { qmd: data.qmd ? "success" : undefined } : undefined;
			return { candidateCount, returnedCount, returnedBytes: result.bounds.returnedBytes, returnedLines: result.bounds.returnedLines, maxBytes: result.bounds.maxBytes, maxLines: result.bounds.maxLines, truncated: result.bounds.truncated, backendSelection, freshnessStates, warningCodes: result.warnings.map((warning) => warning.code), refreshCount, processExitCategories, requestedMode: data.requestedMode, effectiveMode: data.effectiveMode, queueMs: data.queueMs, operationMs: data.operationMs, workerId: data.workerId, outputSchema: "valid" };
		};
		const dispatch = async (request: MarkdownDatastoreRequest, signal?: AbortSignal): Promise<MarkdownDatastoreResult> => {
			if (!service) throw new DatastoreError("STORE_UNAVAILABLE");
			switch (request.operation) {
				case "search": return service.search(request.input, signal);
				case "find": return service.find(request.input, signal);
				case "read": return service.read(request.input, signal);
				case "status": return service.status(request.input, signal);
				case "refresh": return service.refresh(request.input, signal);
				default: throw new DatastoreError("CAPABILITY_UNAVAILABLE");
			}
		};
		const run = async (request: MarkdownDatastoreRequest, signal?: AbortSignal): Promise<MarkdownDatastoreResult> => {
			const started = Date.now(); const store = "store" in request.input ? request.input.store : undefined; observe(request.operation, store, "start", started);
			try { const result = await dispatch(request, signal); observe(request.operation, store, "end", started, structuralMetrics(result)); return result; }
			catch (error) { const safe = datastoreError(error); observe(request.operation, store, "end", started, { errorCode: safe.code, warningCodes: [], processExitCategory: safe.code === "BACKEND_FAILED" || safe.code === "BACKEND_OUTPUT_INVALID" ? "backend-failure" : undefined, outputSchema: safe.code === "BACKEND_OUTPUT_INVALID" ? "invalid" : undefined }); throw safe; }
		};
		const execute = async (request: MarkdownDatastoreRequest, signal?: AbortSignal) => {
			const started = Date.now(); const store = "store" in request.input ? request.input.store : undefined; const result = await run(request, signal); return { content: [{ type: "text" as const, text: toolText(result) }], details: { operation: request.operation, store, durationMs: Date.now() - started, truncated: result.bounds.truncated, warnings: result.warnings.map((warning) => warning.code) } };
		};
		const registerTools = (): void => {
			if (registered) return; registered = true;
			pi.registerTool({ name: "datastore_search", label: "Datastore search", description: "Ranked lexical, semantic, or hybrid retrieval from one configured Markdown store. Returns at most 20 directly validated hits and bounded snippets.", parameters: Schemas.search, execute: (_id, input, signal) => execute({ operation: "search", input }, signal) });
			pi.registerTool({ name: "datastore_find", label: "Datastore find", description: "Deterministically find Markdown notes by exact path or datastore URI. Does not perform similarity search.", parameters: Schemas.find, execute: (_id, input, signal) => execute({ operation: "find", input }, signal) });
			pi.registerTool({ name: "datastore_read", label: "Datastore read", description: "Read a bounded direct Markdown content, section, or outline view. Truncation uses opaque continuations.", parameters: Schemas.read, execute: (_id, input, signal) => execute({ operation: "read", input }, signal) });
			pi.registerTool({ name: "datastore_status", label: "Datastore status", description: "Report configured Markdown store capabilities, protected backend readiness, freshness, counts, and permission warnings without note contents.", parameters: Schemas.status, execute: (_id, input, signal) => execute({ operation: "status", input }, signal) });
			pi.registerTool({ name: "datastore_refresh", label: "Datastore refresh", description: "Start or cancel read-only derived datastore maintenance. Lexical, semantic, and all return prompt durable job receipts; direct performs only bounded root revalidation. Status reports progress. Never mutates source Markdown or runs source synchronization.", parameters: Schemas.refresh, executionMode: "sequential", execute: (_id, input, signal) => execute({ operation: "refresh", input }, signal) });
		};
		const removeRpc = (): void => { rpcUnsubscribe?.(); rpcUnsubscribe = undefined; };
		const rpcMetric = (outcome: "accepted" | "success" | "error" | "invalid" | "expired" | "duplicate-responder", operation?: string, started?: number, code?: string): void => {
			pi.appendEntry("markdown-datastore-rpc", { version: 1, outcome, operation, durationMs: started === undefined ? undefined : Math.max(0, Date.now() - started), code, timestamp: new Date().toISOString() });
		};
		pi.on("session_start", async (_event, ctx) => {
			capabilityUnsubscribe ??= subscribeCapability();
			generation += 1; const ownGeneration = generation; removeRpc(); const previous = service; service = undefined; await previous?.shutdown();
			if (generation !== ownGeneration) return;
			if (!ctx.isProjectTrusted()) { ctx.ui.setStatus("markdown-datastore", "datastore: disabled (project untrusted)"); return; }
			let config; try { config = await loadMarkdownDatastoreConfig(projectRoot, configPath); } catch (error) { const safe = datastoreError(error, "CONFIG_INVALID"); ctx.ui.setStatus("markdown-datastore", `datastore: disabled (${safe.code})`); return; }
			let qmd: QmdAdapter | undefined;
			if (config.qmd.enabled) try { qmd = await (options.createQmd ?? createQmd)(config); } catch {}
			if (generation !== ownGeneration) { await Promise.allSettled([qmd?.shutdown()].filter((operation): operation is Promise<void> => operation !== undefined)); return; }
			service = new MarkdownDatastoreService(config, undefined, qmd); registerTools();
			if (qmd) void qmd.startupReconcile([...config.stores.values()]).catch(() => undefined);
			const rpcListener = (payload: unknown) => {
				let reject: ((error: unknown) => void) | undefined;
				try { if (typeof payload === "object" && payload !== null && typeof (payload as Record<string, unknown>).reject === "function") reject = (payload as Record<string, unknown>).reject as (error: unknown) => void; } catch { return; }
				if (!exactKeys(payload, ["contractVersion", "requestId", "request", "deadline", "signal", "resolve", "reject"]) || payload.contractVersion !== MARKDOWN_DATASTORE_CONTRACT_VERSION || typeof payload.requestId !== "string" || payload.requestId.length < 1 || payload.requestId.length > 128 || typeof payload.deadline !== "number" || !Number.isFinite(payload.deadline) || typeof payload.resolve !== "function" || typeof payload.reject !== "function" || (payload.signal !== undefined && (!(payload.signal instanceof AbortSignal))) || !validRpcRequest(payload.request)) {
					rpcMetric("invalid"); reject?.(new DatastoreError("CONFIG_INVALID")); return;
				}
				const envelope = payload as unknown as MarkdownDatastoreRpcEnvelope;
				if (claimedRpcEnvelopes.has(payload)) { rpcMetric("duplicate-responder", envelope.request.operation); return; }
				claimedRpcEnvelopes.add(payload);
				if (Date.now() >= envelope.deadline) { rpcMetric("expired", envelope.request.operation, undefined, "TIMEOUT"); envelope.reject(new DatastoreError("TIMEOUT")); return; }
				const started = Date.now(); rpcMetric("accepted", envelope.request.operation);
				const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(new DatastoreError("TIMEOUT")), Math.max(1, envelope.deadline - Date.now()));
				const signal = envelope.signal ? AbortSignal.any([envelope.signal, deadline.signal]) : deadline.signal;
				void run(envelope.request, signal).then((result) => { rpcMetric("success", envelope.request.operation, started); envelope.resolve(result); }, (error) => { const safe = datastoreError(error); rpcMetric("error", envelope.request.operation, started, safe.code); envelope.reject(safe); }).finally(() => clearTimeout(timer));
			};
			rpcUnsubscribe = pi.events.on(MARKDOWN_DATASTORE_REQUEST_EVENT, rpcListener); ctx.ui.setStatus("markdown-datastore", "datastore: ready");
		});
		pi.on("session_shutdown", async (_event, ctx) => { generation += 1; removeRpc(); capabilityUnsubscribe?.(); capabilityUnsubscribe = undefined; const current = service; service = undefined; await current?.shutdown(); ctx.ui.setStatus("markdown-datastore", undefined); });
	};
}

export default createMarkdownDatastoreExtension();
