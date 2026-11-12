import type { Socket } from "node:net";
import type { SearchMode } from "./contract.ts";
import { abortError, DatastoreError, throwIfAborted } from "./errors.ts";
import type { QmdSearchResult } from "./qmd-adapter.ts";
import { attachSharedParser, connectSharedSocket, encodeSharedMessage, parseSharedReply, requestId, sharedError, type SharedActivity, type SharedReply } from "./shared-ipc.ts";

export interface SharedAttachment { socketPath: string; store: string; definitionRevision: string }
interface Waiter { resolve(value: unknown): void; reject(error: unknown): void }

export class SharedIndexClient {
	readonly attachment: SharedAttachment;
	#socket?: Socket;
	#connecting?: Socket;
	#generation?: string;
	version = "";
	#pending = new Map<string, Waiter>();
	#opening?: Promise<Socket>;
	#lifecycle = new AbortController();
	#closed = false;
	constructor(attachment: SharedAttachment) { this.attachment = { ...attachment }; }
	private ready(signal?: AbortSignal): Promise<Socket> {
		throwIfAborted(signal);
		if (this.#closed) throw new DatastoreError("CANCELLED");
		if (this.#socket && this.#generation && !this.#socket.destroyed) return Promise.resolve(this.#socket);
		// Attachment belongs to the client lifetime, not whichever caller arrived first.
		this.#opening ??= this.open().finally(() => { this.#opening = undefined; });
		const opening = this.#opening;
		if (!signal) return opening;
		return new Promise((resolve, reject) => {
			const abort = () => { clear(); reject(abortError(signal)); };
			const clear = () => signal.removeEventListener("abort", abort);
			signal.addEventListener("abort", abort, { once: true });
			opening.then(socket => { clear(); resolve(socket); }, error => { clear(); reject(error); });
			if (signal.aborted) abort();
		});
	}
	private async open(): Promise<Socket> {
		const signal = this.#lifecycle.signal;
		throwIfAborted(signal);
		let socket: Socket;
		try { socket = await connectSharedSocket(this.attachment.socketPath, signal); }
		catch { throw signal.aborted ? abortError(signal) : new DatastoreError("STORE_UNAVAILABLE"); }
		this.#connecting = socket;
		const pending = new Map<string, Waiter>();
		let boundGeneration: string | undefined;
		const retire = (error: unknown) => { socket.destroy(); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
		attachSharedParser(socket, message => {
			let reply: SharedReply;
			try {
				reply = parseSharedReply(message);
				if (reply.definitionRevision !== this.attachment.definitionRevision || (boundGeneration && reply.generation !== boundGeneration)) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
			} catch (error) { retire(error); return; }
			const waiter = reply.requestId ? pending.get(reply.requestId) : undefined;
			if (!waiter) return;
			pending.delete(reply.requestId!);
			boundGeneration ??= reply.generation;
			if (!reply.ok) waiter.reject(sharedError(reply.error)); else waiter.resolve(reply.result);
		}, () => retire(new DatastoreError("BACKEND_OUTPUT_INVALID")));
		socket.on("close", () => {
			if (this.#socket === socket) { this.#socket = undefined; this.#generation = undefined; }
			for (const waiter of pending.values()) waiter.reject(signal.aborted ? abortError(signal) : new DatastoreError("STORE_UNAVAILABLE"));
			pending.clear();
		});
		try {
			const hello = await this.send(socket, pending, "hello", undefined, signal) as { generation?: string; version?: string };
			if (typeof hello?.generation !== "string" || hello.generation !== boundGeneration || typeof hello.version !== "string") throw new DatastoreError("BACKEND_OUTPUT_INVALID");
			throwIfAborted(signal);
			if (socket.destroyed) throw new DatastoreError("STORE_UNAVAILABLE");
			this.#generation = hello.generation; this.version = hello.version;
			this.#pending = pending; this.#socket = socket;
			return socket;
		} catch (error) { retire(error); throw error; }
		finally { if (this.#connecting === socket) this.#connecting = undefined; }
	}
	private send(socket: Socket, pending: Map<string, Waiter>, operation: string, input: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
		throwIfAborted(signal);
		const id = requestId();
		const payload = operation === "hello"
			? { version: 1, operation, requestId: id, store: this.attachment.store, definitionRevision: this.attachment.definitionRevision }
			: { version: 1, operation, requestId: id, generation: this.#generation, store: this.attachment.store, definitionRevision: this.attachment.definitionRevision, input };
		return new Promise((resolve, reject) => {
			const finish = (error?: unknown, value?: unknown) => { signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(value); };
			const abort = () => { pending.delete(id); if (!socket.destroyed) socket.write(encodeSharedMessage({ version: 1, operation: "drop", requestId: id })); finish(abortError(signal)); };
			pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) });
			signal?.addEventListener("abort", abort, { once: true });
			socket.write(encodeSharedMessage(payload));
		});
	}
	private async call(operation: string, input: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
		const socket = await this.ready(signal);
		if (!this.#generation) throw new DatastoreError("STORE_UNAVAILABLE");
		return this.send(socket, this.#pending, operation, input, signal);
	}
	async activity(signal?: AbortSignal): Promise<SharedActivity> { return this.call("activity", undefined, signal) as Promise<SharedActivity>; }
	async isLexicallyCurrent(signal?: AbortSignal): Promise<boolean> { return this.call("current", undefined, signal) as Promise<boolean>; }
	async search(query: string, mode: SearchMode, limit: number, minScore: number | undefined, signal?: AbortSignal): Promise<QmdSearchResult> { return this.call("search", { query, mode, limit, minScore }, signal) as Promise<QmdSearchResult>; }
	async status(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.call("status", undefined, signal) as Promise<Record<string, unknown>>; }
	async startLexical(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.call("startLexical", undefined, signal) as Promise<Record<string, unknown>>; }
	async startSemantic(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.call("startSemantic", undefined, signal) as Promise<Record<string, unknown>>; }
	async cancel(refreshId: string, signal?: AbortSignal): Promise<Record<string, unknown>> { return this.call("cancel", { refreshId }, signal) as Promise<Record<string, unknown>>; }
	async startMetadata(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.call("startMetadata", undefined, signal) as Promise<Record<string, unknown>>; }
	async links(path: string, input: { continuation?: string; maxBytes?: number; maxLines?: number } = {}, signal?: AbortSignal): Promise<{ edges: { target: string; targetKind: "note" | "attachment" | "unresolved" | "ambiguous" }[]; pageCount: number; occurrenceCount: number; returned: number; complete: boolean; revision: string; diagnostics?: string[]; continuation?: string }> { return this.call("links", { path, ...input }, signal) as Promise<{ edges: { target: string; targetKind: "note" | "attachment" | "unresolved" | "ambiguous" }[]; pageCount: number; occurrenceCount: number; returned: number; complete: boolean; revision: string; diagnostics?: string[]; continuation?: string }>; }
	async backlinks(path: string, input: { continuation?: string; maxBytes?: number; maxLines?: number } = {}, signal?: AbortSignal): Promise<{ edges: { target: string; targetKind: "note" | "attachment" | "unresolved" | "ambiguous" }[]; pageCount: number; occurrenceCount: number; returned: number; complete: boolean; revision: string; diagnostics?: string[]; continuation?: string }> { return this.call("backlinks", { path, ...input }, signal) as Promise<{ edges: { target: string; targetKind: "note" | "attachment" | "unresolved" | "ambiguous" }[]; pageCount: number; occurrenceCount: number; returned: number; complete: boolean; revision: string; diagnostics?: string[]; continuation?: string }>; }
	async tagPages(tag: string, input: { continuation?: string; limit?: number; maxBytes?: number; maxLines?: number } = {}, signal?: AbortSignal): Promise<{ pages: string[]; total: number; returned: number; complete: boolean; revision: string; continuation?: string }> { return this.call("tagPages", { tag, ...input }, signal) as Promise<{ pages: string[]; total: number; returned: number; complete: boolean; revision: string; continuation?: string }>; }
	async tags(input: { continuation?: string; maxBytes?: number; maxLines?: number } = {}, signal?: AbortSignal): Promise<{ tags: { identity: string; spelling: string; pageCount: number }[]; total: number; returned: number; revision: string; continuation?: string }> { return this.call("tags", input, signal) as Promise<{ tags: { identity: string; spelling: string; pageCount: number }[]; total: number; returned: number; revision: string; continuation?: string }>; }
	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#lifecycle.abort(new DatastoreError("CANCELLED"));
		this.#connecting?.destroy(); this.#socket?.destroy();
		await this.#opening?.catch(() => undefined);
		this.#socket = undefined; this.#connecting = undefined; this.#generation = undefined;
	}
}
