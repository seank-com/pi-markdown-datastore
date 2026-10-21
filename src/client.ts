import { randomUUID } from "node:crypto";

import {
	MARKDOWN_DATASTORE_CONTRACT_VERSION,
	MARKDOWN_DATASTORE_CAPABILITY_REQUEST,
	MARKDOWN_DATASTORE_CAPABILITY_REPLY,
	type MarkdownDatastoreCapability,
	type MarkdownDatastoreCapabilityReply,
	MARKDOWN_DATASTORE_REQUEST_EVENT,
	type MarkdownDatastorePolicyV1, type RootsResult, type DestinationResult,
	type FindInput,
	type FindResult,
	type MarkdownDatastoreRequest,
	type MarkdownDatastoreResult,
	type MarkdownDatastoreRpcEnvelope,
	type MarkdownDatastoreServiceV1,
	type ReadInput,
	type ReadResult,
	type RefreshInput,
	type RefreshResult,
	type SearchInput,
	type SearchResult,
	type StatusInput,
	type StatusResult,
} from "./contract.ts";

export interface MarkdownDatastoreEventBus {
	emit(event: string, payload: unknown): unknown;
}

export interface MarkdownDatastoreCapabilityBus extends MarkdownDatastoreEventBus {
	on(event: string, handler: (payload: unknown) => void): () => void;
}

/** Query after all session_start handlers (Pi resources_discover). No operation timer is used. */
export function queryMarkdownDatastoreCapability(events: MarkdownDatastoreCapabilityBus): MarkdownDatastoreCapability | undefined {
	const requestId = randomUUID();
	let capability: MarkdownDatastoreCapability | undefined;
	let replies = 0;
	const unsubscribe = events.on(MARKDOWN_DATASTORE_CAPABILITY_REPLY, (payload) => {
		const reply = payload as Partial<MarkdownDatastoreCapabilityReply> | null;
		if (!reply || reply.version !== 1 || reply.requestId !== requestId) return;
		const candidate = reply.capability;
		if (!candidate || candidate.version !== 1 || candidate.contractVersion !== 1 || typeof candidate.ready !== "boolean"
			|| !Array.isArray(candidate.stores) || candidate.stores.length > 100
			|| candidate.stores.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(name))
			|| new Set(candidate.stores).size !== candidate.stores.length) return;
		capability = candidate; replies++;
	});
	try { events.emit(MARKDOWN_DATASTORE_CAPABILITY_REQUEST, { version: 1, requestId }); }
	finally { unsubscribe(); }
	return replies === 1 ? capability : undefined;
}

export const DEFAULT_MARKDOWN_DATASTORE_CLIENT_TIMEOUT_MS = 15 * 60_000;

export interface MarkdownDatastoreClientOptions {
	timeoutMs?: number;
	/** Bind policy requests to a capability discovered for this effective instance. */
	capability?: MarkdownDatastoreCapability;
	createRequestId?: () => string;
	now?: () => number;
}

export type MarkdownDatastoreClientErrorCode = "TIMEOUT" | "CANCELLED" | "BACKEND_OUTPUT_INVALID" | "CAPABILITY_UNAVAILABLE";

export class MarkdownDatastoreClientError extends Error {
	readonly code: MarkdownDatastoreClientErrorCode;
	constructor(code: MarkdownDatastoreClientErrorCode) {
		super(code);
		this.name = "MarkdownDatastoreClientError";
		this.code = code;
	}
}

function validResult(value: unknown, operation: MarkdownDatastoreRequest["operation"]): value is MarkdownDatastoreResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	if (operation === "roots" || operation === "validateDestination") {
		const data = result.data as Record<string, unknown> | null;
		if (!data || typeof data !== "object" || Array.isArray(data) || (result.bounds as { truncated?: unknown } | null)?.truncated !== false) return false;
		const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
		if (operation === "roots") {
			if (!Array.isArray(data.roots) || data.roots.length === 0 || !data.roots.every(root => root && typeof root === "object" && typeof root.store === "string" && typeof root.path === "string" && root.path.startsWith("/") && Number.isInteger(root.device) && Number.isInteger(root.inode))) return false;
		} else if (typeof data.path !== "string" || !data.path.startsWith("/") || typeof data.owned !== "boolean" || !strings(data.stores) || data.owned !== (data.stores.length > 0)) return false;
	}
	return result.contractVersion === MARKDOWN_DATASTORE_CONTRACT_VERSION
		&& result.operation === operation
		&& typeof result.store === "string"
		&& result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)
		&& result.provenance !== null && typeof result.provenance === "object" && !Array.isArray(result.provenance)
		&& result.bounds !== null && typeof result.bounds === "object" && !Array.isArray(result.bounds)
		&& Array.isArray(result.warnings);
}

export function createMarkdownDatastoreClient(
	events: MarkdownDatastoreEventBus,
	options: MarkdownDatastoreClientOptions = {},
): MarkdownDatastoreServiceV1 & MarkdownDatastorePolicyV1 {
	const timeoutMs = options.timeoutMs ?? DEFAULT_MARKDOWN_DATASTORE_CLIENT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) {
		throw new RangeError("Markdown datastore client timeoutMs must be an integer from 1 to 900000");
	}
	const createRequestId = options.createRequestId ?? randomUUID;
	const now = options.now ?? Date.now;

	const request = <T extends MarkdownDatastoreResult>(value: MarkdownDatastoreRequest, signal?: AbortSignal): Promise<T> => {
		const policy = value.operation === "roots" || value.operation === "validateDestination";
		if (policy && (options.capability?.policyVersion !== 1 || !options.capability.instanceId)) return Promise.reject(new MarkdownDatastoreClientError("CAPABILITY_UNAVAILABLE"));
		if (signal?.aborted) return Promise.reject(new MarkdownDatastoreClientError("CANCELLED"));
		const startedAt = now();
		const deadline = startedAt + timeoutMs;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const cancellation = new AbortController();
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				callback();
			};
			const cancel = (code: "CANCELLED" | "TIMEOUT"): void => finish(() => {
				const error = new MarkdownDatastoreClientError(code);
				cancellation.abort(error);
				reject(error);
			});
			const onAbort = (): void => cancel("CANCELLED");
			const timer = setTimeout(
				() => cancel("TIMEOUT"),
				Math.max(1, deadline - now()),
			);
			timer.unref?.();
			signal?.addEventListener("abort", onAbort, { once: true });
			const envelope: MarkdownDatastoreRpcEnvelope = {
				contractVersion: MARKDOWN_DATASTORE_CONTRACT_VERSION,
				requestId: createRequestId(),
				request: value,
				...(policy ? { instanceId: options.capability!.instanceId } : {}),
				deadline,
				signal: cancellation.signal,
				resolve: (result) => finish(() => {
					if (!validResult(result, value.operation)) reject(new MarkdownDatastoreClientError("BACKEND_OUTPUT_INVALID"));
					else resolve(result as T);
				}),
				reject: (error) => finish(() => reject(error)),
			};
			try {
				events.emit(MARKDOWN_DATASTORE_REQUEST_EVENT, envelope);
			} catch (error) {
				finish(() => reject(error));
			}
		});
	};

	return {
		roots: (input, signal) => request<RootsResult>({ operation: "roots", input }, signal),
		validateDestination: (input, signal) => request<DestinationResult>({ operation: "validateDestination", input }, signal),
		search: (input: SearchInput, signal?: AbortSignal) => request<SearchResult>({ operation: "search", input }, signal),
		find: (input: FindInput, signal?: AbortSignal) => request<FindResult>({ operation: "find", input }, signal),
		read: (input: ReadInput, signal?: AbortSignal) => request<ReadResult>({ operation: "read", input }, signal),
		status: (input: StatusInput, signal?: AbortSignal) => request<StatusResult>({ operation: "status", input }, signal),
		refresh: (input: RefreshInput, signal?: AbortSignal) => request<RefreshResult>({ operation: "refresh", input }, signal),
	};
}
