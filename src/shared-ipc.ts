import { randomBytes } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
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
	operation: "search" | "status" | "startLexical" | "startSemantic" | "cancel" | "activity" | "current";
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
	error?: { code: string };
}

export function encodeSharedMessage(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function attachSharedParser(socket: Socket, onMessage: (message: SharedRequest | SharedReply) => void, onFailure: (error: unknown) => void): void {
	let pending = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		pending += chunk;
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			try { onMessage(JSON.parse(line)); } catch (error) { onFailure(error); return; }
			newline = pending.indexOf("\n");
		}
	});
}

export async function listenOwnedSocket(socketPath: string, onConnection: (socket: Socket) => void): Promise<Server> {
	await mkdir(dirname(socketPath), { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
	const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
	if (existing) {
		if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new DatastoreError("CONFIG_INVALID");
		await rm(socketPath);
	}
	const server = createServer(onConnection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => { server.off("error", reject); resolve(); });
	});
	return server;
}

export function connectSharedSocket(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const fail = (error: unknown) => { socket.destroy(); reject(error); };
		socket.once("error", fail);
		socket.once("connect", () => { socket.off("error", fail); resolve(socket); });
	});
}

export function generationId(): string {
	return `gen-${randomBytes(16).toString("hex")}`;
}

export function sharedError(error: unknown): DatastoreError {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return new DatastoreError(error.code as DatastoreError["code"]);
	return datastoreError(error, "STORE_UNAVAILABLE");
}

export interface SharedSearchInput { query: string; mode: SearchMode; limit: number; minScore?: number }
export type SharedActivity = { state: "running" | "queued" | "idle"; active: boolean; queued: boolean; embeddingActive: boolean; jobs: QmdRefreshJob[]; semanticBatchError?: string };
export type { QmdSearchResult };
export function requestId(): string { return randomBytes(16).toString("hex"); }
export function throwShared(signal?: AbortSignal): void { throwIfAborted(signal); }
