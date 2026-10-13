import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { datastoreChildEnvironment } from "./child-environment.ts";
import { abortError, DatastoreError, throwIfAborted } from "./errors.ts";

const WORKER_PATH = fileURLToPath(new URL("./qmd-worker.mjs", import.meta.url));
const MAX_MESSAGE_BYTES = 1024 * 1024;
const CANCEL_GRACE_MS = 100;
const KILL_GRACE_MS = 250;

export interface QmdWorkerRequest { [key: string]: unknown; version: 2; sdkUrl: string; dbPath: string; config: unknown; operation: string }
export interface QmdWorkerProgress {
	phase: "updating" | "embedding";
	documents?: { completed: number; total: number };
	chunks?: { completed: number; total: number };
	bytes?: { completed: number; total: number };
	errors?: number;
}
interface Pending {
	id: string; operation: string; progressive: boolean; resolve(value: unknown): void; reject(error: DatastoreError): void;
	signal?: AbortSignal; abort: () => void; startupTimer?: NodeJS.Timeout; onProgress?: (progress: QmdWorkerProgress) => void;
}

function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function exactShape(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { const allowed = [...required, ...optional]; return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value); }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function validStatus(value: unknown): boolean { const item = record(value); return !!item && exactShape(item, ["totalDocuments", "needsEmbedding", "hasVectorIndex"]) && safeInteger(item.totalDocuments) && safeInteger(item.needsEmbedding) && typeof item.hasVectorIndex === "boolean"; }
function validateResult(operation: string, data: unknown): boolean {
 const item=record(data);if(!item || !validStatus(item.status))return false;
 if(operation === "search") return Array.isArray(item.results) && item.results.length<=500 && item.results.every((v:any)=>v && typeof v.uri==="string" && v.uri.length<=8192 && /^[0-9a-f]{64}$/.test(v.indexedRevision) && (v.score===undefined || Number.isFinite(v.score)));
 if(operation === "status") return !!record(item.health) && Array.isArray(item.collections) && item.collections.length<=100;
 if(operation === "refresh") { const update=record(item.update),embed=record(item.embed); return !!update && ["indexed","updated","unchanged","removed","skipped","needsEmbedding"].every(key=>safeInteger(update[key])) && (item.embed===undefined || !!embed && ["docsProcessed","chunksEmbedded","errors","durationMs"].every(key=>safeInteger(embed[key]))); }
 return false;
}
function validateProgress(value: unknown): QmdWorkerProgress {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
	const progress = value as Record<string, unknown>; if (progress.phase === "updating" ? !exactShape(progress, ["phase", "documents"], ["errors"]) : progress.phase === "embedding" ? !exactShape(progress, ["phase", "chunks", "bytes"], ["errors"]) : true) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
	for (const key of ["documents", "chunks", "bytes"] as const) if (progress[key] !== undefined) { const metric = progress[key] as Record<string, unknown>; if (!metric || typeof metric !== "object" || Array.isArray(metric) || Object.keys(metric).some((field) => !["completed", "total"].includes(field)) || !safeInteger(metric.completed) || !safeInteger(metric.total) || metric.completed > metric.total) throw new DatastoreError("BACKEND_OUTPUT_INVALID"); }
	if (progress.errors !== undefined && !safeInteger(progress.errors)) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
	return progress as unknown as QmdWorkerProgress;
}

export class QmdWorkerClient {
	readonly timeoutMs: number; #child?: ChildProcessWithoutNullStreams; #pending?: Pending; #stdout = Buffer.alloc(0); #stderrBytes = 0; #closed = false; #terminating = false; #terminationError?: DatastoreError;
	readonly idleExitMs?: number;
	constructor(timeoutMs: number, options: { idleExitMs?: number } = {}) { this.timeoutMs = timeoutMs; if (options.idleExitMs !== undefined && (!Number.isSafeInteger(options.idleExitMs) || options.idleExitMs < 25 || options.idleExitMs > 300_000)) throw new DatastoreError("BACKEND_OUTPUT_INVALID"); this.idleExitMs = options.idleExitMs; }
	get busy(): boolean { return this.#pending !== undefined || this.#terminating; }
	get processId(): number | undefined { return this.#child?.pid; }
	private ensureChild(): ChildProcessWithoutNullStreams {
		if (this.#closed) throw new DatastoreError("CANCELLED"); if (this.#terminating) throw new DatastoreError("BACKEND_FAILED"); if (this.#child) return this.#child;
		const child = spawn(process.execPath, [WORKER_PATH, ...(this.idleExitMs === undefined ? [] : [`--idle-exit-ms=${this.idleExitMs}`])], { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: datastoreChildEnvironment() }); this.#child = child; this.#stdout = Buffer.alloc(0); this.#stderrBytes = 0;
		child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
		child.stderr.on("data", (chunk: Buffer) => { this.#stderrBytes += chunk.length; if (this.#stderrBytes > MAX_MESSAGE_BYTES) this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); });
		child.on("error", () => this.fail(new DatastoreError("BACKEND_FAILED"), false));
		child.on("close", () => { const error = this.#terminationError ?? new DatastoreError("BACKEND_FAILED"); if (this.#child === child) { this.#child = undefined; this.#terminating = false; this.#terminationError = undefined; } if (this.#pending) this.fail(error, false); });
		return child;
	}
	private consume(chunk: Buffer): void {
		this.#stdout = Buffer.concat([this.#stdout, chunk]); if (this.#stdout.length > MAX_MESSAGE_BYTES) { this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); return; }
		for (;;) { const newline = this.#stdout.indexOf(10); if (newline < 0) return; const line = this.#stdout.subarray(0, newline); this.#stdout = this.#stdout.subarray(newline + 1); if (line.length === 0) continue; let message: any; try { message = JSON.parse(line.toString("utf8")); } catch { this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); return; } this.message(message); }
	}
	private message(message: any): void {
		const pending = this.#pending; if (!pending || message?.version !== 2 || message.id !== pending.id || typeof message.type !== "string") { this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); return; }
		if (message.type === "progress") { if (!exactShape(message, ["version", "id", "type", "progress"]) || !pending.progressive) { this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); return; } let progress; try { progress = validateProgress(message.progress); } catch (error) { this.fail(error as DatastoreError, true); return; } this.progress(pending, progress); return; }
		if (message.type === "result") { if (this.#terminating) return; if (!exactShape(message, ["version", "id", "type", "data"]) || !validateResult(pending.operation, message.data)) { this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); return; } this.settle(undefined, message.data); return; }
		if (message.type === "error") { if (this.#terminating) return; if (!exactShape(message, ["version", "id", "type", "code"]) || !["CANCELLED", "RESULT_LIMIT_EXCEEDED", "BACKEND_FAILED"].includes(message.code)) { this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); return; } this.fail(new DatastoreError(message.code === "CANCELLED" ? "CANCELLED" : message.code === "RESULT_LIMIT_EXCEEDED" ? "RESULT_LIMIT_EXCEEDED" : "BACKEND_FAILED"), false); return; }
		this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true);
	}
	private progress(pending: Pending, progress: QmdWorkerProgress): void {
        pending.onProgress?.(progress);
 }

	request(request: QmdWorkerRequest, options: { signal?: AbortSignal; progressive?: boolean; onProgress?: (progress: QmdWorkerProgress) => void } = {}): Promise<any> {
		throwIfAborted(options.signal); if (this.#pending) return Promise.reject(new DatastoreError("BACKEND_FAILED")); const child = this.ensureChild(); const id = randomBytes(16).toString("hex");
		return new Promise((resolve, reject) => { const abort = () => this.cancel(abortError(options.signal)); const pending: Pending = { id, operation: request.operation, progressive: options.progressive === true, resolve, reject, signal: options.signal, abort, onProgress: options.onProgress }; this.#stderrBytes = 0; this.#pending = pending; options.signal?.addEventListener("abort", abort, { once: true }); pending.startupTimer = setTimeout(() => this.fail(new DatastoreError("TIMEOUT"), true), this.timeoutMs); const frame = Buffer.from(`${JSON.stringify({ ...request, id })}\n`); if (frame.length > MAX_MESSAGE_BYTES) { this.fail(new DatastoreError("BACKEND_OUTPUT_INVALID"), true); return; } child.stdin.write(frame, (error) => { if (error) this.fail(new DatastoreError("BACKEND_FAILED"), false); }); });
	}
	private clear(pending: Pending): void { if (pending.startupTimer) clearTimeout(pending.startupTimer); pending.signal?.removeEventListener("abort", pending.abort); }
	private settle(error?: DatastoreError, value?: unknown): void { const pending = this.#pending; if (!pending) return; this.#pending = undefined; this.clear(pending); error ? pending.reject(error) : pending.resolve(value); }
	private fail(error: DatastoreError, terminate: boolean): void { if (!terminate) { this.settle(error); return; } this.#terminating = true; this.#terminationError = error; this.terminate(); }
	private cancel(error: DatastoreError): void { const child = this.#child; const pending = this.#pending; if (!child || !pending) { this.settle(error); return; } this.#terminating = true; this.#terminationError = error; try { child.stdin.write(`${JSON.stringify({ version: 2, id: pending.id, type: "cancel" })}\n`); } catch {} const term = setTimeout(() => { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGTERM"); } catch {} }, CANCEL_GRACE_MS); const kill = setTimeout(() => { if (this.#child === child) try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch {} }, KILL_GRACE_MS); term.unref(); kill.unref(); }
	private terminate(): void { const child = this.#child; if (!child) return; try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }
	async shutdown(): Promise<void> { if (this.#closed) return; this.#closed = true; if (this.#pending) this.cancel(new DatastoreError("CANCELLED")); const child = this.#child; if (!child) return; await new Promise<void>((resolve) => { const timer = setTimeout(() => { this.terminate(); }, KILL_GRACE_MS); child.once("close", () => { clearTimeout(timer); resolve(); }); try { child.stdin.write(`${JSON.stringify({ version: 2, type: "shutdown" })}\n`); } catch { this.terminate(); } }); }
}
