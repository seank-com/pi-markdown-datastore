import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { DatastoreError, datastoreError, throwIfAborted } from "./errors.ts";
import type { SearchMode } from "./contract.ts";
import type { QmdRefreshJob, QmdSearchResult } from "./qmd-adapter.ts";

export const SHARED_IPC_VERSION = 1;

export interface SharedHello {
	version: 1;
	operation: "hello";
	requestId?: string;
	store: string;
	definitionRevision: string;
}
export interface SharedCall {
	version: 1;
	operation: "search" | "status" | "startLexical" | "startSemantic" | "startMetadata" | "links" | "backlinks" | "tagPages" | "tags" | "cancel" | "activity" | "current";
	requestId: string;
	generation: string;
	store: string;
	definitionRevision: string;
	input?: Record<string, unknown>;
}
export interface SharedDrop { version: 1; operation: "drop"; requestId: string }
export type SharedRequest = SharedHello | SharedCall | SharedDrop;
export interface SharedReply {
	version: 1;
	requestId?: string;
	generation: string;
	definitionRevision: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; details?: { operationApplied: true; refreshIds: string[] } };
}

export function encodeSharedMessage(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

const STORE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ID = /^[0-9a-f]{32}$/;
const REVISION = /^[0-9a-f]{64}$/;
const GENERATION = /^gen-[0-9a-f]{32}$/;
const CALLS = new Set(["search", "status", "startLexical", "startSemantic", "startMetadata", "links", "backlinks", "tagPages", "tags", "cancel", "activity", "current"]);

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DatastoreError("CONFIG_INVALID");
	return value as Record<string, unknown>;
}
export function parseSharedRequest(value: unknown): SharedRequest {
	const message = record(value);
	if (message.version !== 1 || typeof message.operation !== "string") throw new DatastoreError("CONFIG_INVALID");
	if (message.operation === "drop") {
		if (typeof message.requestId !== "string" || !ID.test(message.requestId) || Object.keys(message).some((key) => !["version", "operation", "requestId"].includes(key))) throw new DatastoreError("CONFIG_INVALID");
		return { version: 1, operation: "drop", requestId: message.requestId };
	}
	if (typeof message.store !== "string" || !STORE_NAME.test(message.store) || typeof message.definitionRevision !== "string" || !REVISION.test(message.definitionRevision)) throw new DatastoreError("CONFIG_INVALID");
	if (message.operation === "hello") return { version: 1, operation: "hello", requestId: typeof message.requestId === "string" ? message.requestId : undefined, store: message.store, definitionRevision: message.definitionRevision };
	if (!CALLS.has(message.operation) || typeof message.requestId !== "string" || !ID.test(message.requestId) || typeof message.generation !== "string" || !GENERATION.test(message.generation)) throw new DatastoreError("CONFIG_INVALID");
	return { version: 1, operation: message.operation as SharedCall["operation"], requestId: message.requestId, generation: message.generation, store: message.store, definitionRevision: message.definitionRevision, input: message.input && typeof message.input === "object" ? message.input as Record<string, unknown> : undefined };
}
export function parseSharedReply(value: unknown): SharedReply {
	const message = record(value);
	if (message.version !== 1 || typeof message.generation !== "string" || !GENERATION.test(message.generation) || typeof message.definitionRevision !== "string" || typeof message.ok !== "boolean") throw new DatastoreError("BACKEND_OUTPUT_INVALID");
	if (message.requestId !== undefined && (typeof message.requestId !== "string" || !ID.test(message.requestId))) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
	return { version: 1, requestId: message.requestId as string | undefined, generation: message.generation, definitionRevision: message.definitionRevision, ok: message.ok, result: message.result, error: message.error && typeof message.error === "object" ? message.error as SharedReply["error"] : undefined };
}
export function containSocket(socket: Socket): void {
	socket.on("error", () => { socket.destroy(); });
}
function endpointIsLive(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const finish = (live: boolean) => { socket.destroy(); resolve(live); };
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
export function attachSharedParser(socket: Socket, onMessage: (message: SharedRequest | SharedReply) => void, onFailure: (error: unknown) => void): void {
	let pending = "";
	socket.setEncoding("utf8");
	const release = () => { pending = ""; socket.off("data", onData); socket.off("close", release); };
	const onData = (chunk: string) => {
		pending += chunk;
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			try { onMessage(JSON.parse(line)); } catch (error) { release(); onFailure(error); return; }
			newline = pending.indexOf("\n");
		}
	};
	socket.on("data", onData);
	socket.on("close", release);
}

export async function listenOwnedSocket(socketPath: string, onConnection: (socket: Socket) => void): Promise<Server> {
	const parent = dirname(socketPath);
	let created = false;
	await mkdir(parent, { recursive: false, mode: 0o700 }).then(() => { created = true; }, (error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
	if (created) await chmod(parent, 0o700);
	const parentInfo = await lstat(parent);
	if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o077) !== 0) throw new DatastoreError("CONFIG_INVALID");
	const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (existing) {
		if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new DatastoreError("CONFIG_INVALID");
		if (await endpointIsLive(socketPath)) throw new DatastoreError("STORE_UNAVAILABLE");
		await rm(socketPath);
	}
	const server = createServer((socket) => { containSocket(socket); onConnection(socket); });
	server.on("error", () => { server.close(); });
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => { server.off("error", reject); resolve(); });
	});
	await chmod(socketPath, 0o600);
	const bound = await lstat(socketPath);
	if (!bound.isSocket() || bound.uid !== process.getuid?.() || (bound.mode & 0o077) !== 0) { server.close(); throw new DatastoreError("CONFIG_INVALID"); }
	return server;
}

export function connectSharedSocket(socketPath: string, signal?: AbortSignal): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path: socketPath, signal });
		const fail = (error: unknown) => { socket.destroy(); reject(error); };
		socket.once("error", fail);
		socket.once("connect", () => { socket.off("error", fail); containSocket(socket); resolve(socket); });
	});
}

export function generationId(): string {
	return `gen-${randomBytes(16).toString("hex")}`;
}

export function sharedError(error: unknown): DatastoreError {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
		const details = (error as { details?: unknown }).details;
		if (details && typeof details === "object" && "operationApplied" in details && details.operationApplied === true) {
			const ids = (details as { refreshIds?: unknown }).refreshIds;
			if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && /^[0-9a-f]{32}$/.test(id))) return new DatastoreError("BACKEND_OUTPUT_INVALID");
			return new DatastoreError(error.code as DatastoreError["code"], { operationApplied: true, refreshIds: [...ids] });
		}
		return new DatastoreError(error.code as DatastoreError["code"]);
	}
	return datastoreError(error, "STORE_UNAVAILABLE");
}

export interface SharedSearchInput { query: string; mode: SearchMode; limit: number; minScore?: number }
export type SharedActivity = { state: "running" | "queued" | "idle"; active: boolean; queued: boolean; embeddingActive: boolean; jobs: QmdRefreshJob[]; semanticBatchError?: string };
export type { QmdSearchResult };
export function requestId(): string { return randomBytes(16).toString("hex"); }
export function throwShared(signal?: AbortSignal): void { throwIfAborted(signal); }
