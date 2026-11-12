import type { Socket } from "node:net";
import type { SearchMode } from "./contract.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import type { QmdSearchResult } from "./qmd-adapter.ts";
import { attachSharedParser, connectSharedSocket, containSocket, encodeSharedMessage, parseSharedReply, requestId, sharedError, type SharedActivity, type SharedReply } from "./shared-ipc.ts";

export interface SharedAttachment { socketPath: string; store: string; definitionRevision: string }

export class SharedIndexClient {
	readonly attachment: SharedAttachment;
	#socket?: Socket;
	#generation?: string;
	version = "";
	#pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
	#opening?: Promise<Socket>;
	#closed = false;
	constructor(attachment: SharedAttachment) { this.attachment = attachment; }
	private ready(signal?: AbortSignal): Promise<Socket> {
		throwIfAborted(signal);
		if (this.#closed) throw new DatastoreError("CANCELLED");
		if (this.#socket && this.#generation && !this.#socket.destroyed) return Promise.resolve(this.#socket);
		if (!this.#opening) this.#opening = this.open(signal).finally(() => { this.#opening = undefined; });
		return this.#opening;
	}
	private async open(signal?: AbortSignal): Promise<Socket> {
		throwIfAborted(signal);
		let socket: Socket;
		try { socket = await connectSharedSocket(this.attachment.socketPath); }
		catch { throw new DatastoreError("STORE_UNAVAILABLE"); }
		containSocket(socket);
		const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
		attachSharedParser(socket, (message) => {
			let reply: SharedReply;
			try { reply = parseSharedReply(message); } catch (error) { socket.destroy(); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); return; }
			const waiter = reply.requestId ? pending.get(reply.requestId) : undefined;
			if (!waiter) return;
			pending.delete(reply.requestId!);
			if (!reply.ok) waiter.reject(sharedError(reply.error));
			else waiter.resolve(reply.result);
		}, () => socket.destroy());
		socket.on("close", () => {
			if (this.#socket === socket) { this.#socket = undefined; this.#generation = undefined; }
			for (const waiter of pending.values()) waiter.reject(new DatastoreError("STORE_UNAVAILABLE"));
			pending.clear();
		});
		const hello = await this.send(socket, pending, "hello", undefined, signal) as { generation?: string; version?: string };
		if (typeof hello.generation !== "string" || !/^gen-[0-9a-f]{32}$/.test(hello.generation) || typeof hello.version !== "string") { socket.destroy(); throw new DatastoreError("STORE_UNAVAILABLE"); }
		this.#generation = hello.generation;
		this.version = hello.version;
		this.#pending = pending;
		this.#socket = socket;
		return socket;
	}
	private send(socket: Socket, pending: Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>, operation: string, input: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
		throwIfAborted(signal);
		const id = requestId();
		const payload = operation === "hello"
			? { version: 1, operation, requestId: id, store: this.attachment.store, definitionRevision: this.attachment.definitionRevision }
			: { version: 1, operation, requestId: id, generation: this.#generation, store: this.attachment.store, definitionRevision: this.attachment.definitionRevision, input };
		return new Promise((resolve, reject) => {
			const finish = (error?: unknown, value?: unknown) => { signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(value); };
			const abort = () => { pending.delete(id); socket.write(encodeSharedMessage({ version: 1, operation: "drop", requestId: id })); finish(new DatastoreError("CANCELLED")); };
			pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
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
	async shutdown(): Promise<void> { this.#closed = true; this.#socket?.destroy(); this.#socket = undefined; this.#generation = undefined; }
}
