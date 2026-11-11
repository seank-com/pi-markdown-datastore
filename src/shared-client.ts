import type { Socket } from "node:net";
import type { SearchMode } from "./contract.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import type { QmdSearchResult } from "./qmd-adapter.ts";
import { attachSharedParser, connectSharedSocket, encodeSharedMessage, requestId, sharedError, type SharedActivity, type SharedReply } from "./shared-ipc.ts";

export interface SharedAttachment { socketPath: string; store: string; definitionRevision: string }

export class SharedIndexClient {
	readonly attachment: SharedAttachment;
	#socket?: Socket;
	#generation?: string;
	version = "";
	#pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
	#closed = false;
	constructor(attachment: SharedAttachment) { this.attachment = attachment; }
	private async socket(signal?: AbortSignal): Promise<Socket> {
		throwIfAborted(signal);
		if (this.#closed) throw new DatastoreError("CANCELLED");
		if (this.#socket && !this.#socket.destroyed) return this.#socket;
		let socket: Socket;
		try { socket = await connectSharedSocket(this.attachment.socketPath); }
		catch { throw new DatastoreError("STORE_UNAVAILABLE"); }
		this.#socket = socket;
		attachSharedParser(socket, (message) => {
			const reply = message as SharedReply;
			const pending = reply.requestId ? this.#pending.get(reply.requestId) : undefined;
			if (!pending) return;
			this.#pending.delete(reply.requestId!);
			if (!reply.ok) pending.reject(sharedError(reply.error));
			else pending.resolve(reply.result);
		}, () => socket.destroy());
		socket.on("close", () => {
			if (this.#socket === socket) this.#socket = undefined;
			this.#generation = undefined;
			for (const pending of this.#pending.values()) pending.reject(new DatastoreError("STORE_UNAVAILABLE"));
			this.#pending.clear();
		});
		const hello = await this.call("hello", undefined, signal) as { generation: string; version: string };
		if (this.#generation && this.#generation !== hello.generation) throw new DatastoreError("STORE_UNAVAILABLE");
		this.#generation = hello.generation;
		this.version = hello.version;
		return socket;
	}
	private call(operation: string, input: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
		throwIfAborted(signal);
		const id = requestId();
		const payload = operation === "hello"
			? { version: 1, operation, store: this.attachment.store, definitionRevision: this.attachment.definitionRevision }
			: { version: 1, operation, requestId: id, generation: this.#generation, store: this.attachment.store, definitionRevision: this.attachment.definitionRevision, input };
		return new Promise((resolve, reject) => {
			const finish = (error?: unknown, value?: unknown) => {
				signal?.removeEventListener("abort", abort);
				if (error) reject(error); else resolve(value);
			};
			const abort = () => { this.#pending.delete(id); this.#socket?.write(encodeSharedMessage({ version: 1, operation: "drop", requestId: id })); finish(new DatastoreError("CANCELLED")); };
			if (operation !== "hello") this.#pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
			const helloPending = operation === "hello" ? { resolve: (value: unknown) => finish(undefined, value), reject: (error: unknown) => finish(error) } : undefined;
			if (helloPending) this.#pending.set(id, helloPending);
			signal?.addEventListener("abort", abort, { once: true });
			const socket = this.#socket;
			if (!socket) { finish(new DatastoreError("STORE_UNAVAILABLE")); return; }
			socket.write(encodeSharedMessage(operation === "hello" ? { ...payload, requestId: id } : payload));
		});
	}
	async activity(signal?: AbortSignal): Promise<SharedActivity> {
		await this.socket(signal);
		return this.call("activity", undefined, signal) as Promise<SharedActivity>;
	}
	async isLexicallyCurrent(signal?: AbortSignal): Promise<boolean> {
		await this.socket(signal);
		return this.call("current", undefined, signal) as Promise<boolean>;
	}
	async search(query: string, mode: SearchMode, limit: number, minScore: number | undefined, signal?: AbortSignal): Promise<QmdSearchResult> {
		await this.socket(signal);
		return this.call("search", { query, mode, limit, minScore }, signal) as Promise<QmdSearchResult>;
	}
	async status(signal?: AbortSignal): Promise<Record<string, unknown>> {
		await this.socket(signal);
		return this.call("status", undefined, signal) as Promise<Record<string, unknown>>;
	}
	async startLexical(signal?: AbortSignal): Promise<Record<string, unknown>> {
		await this.socket(signal);
		return this.call("startLexical", undefined, signal) as Promise<Record<string, unknown>>;
	}
	async startSemantic(signal?: AbortSignal): Promise<Record<string, unknown>> {
		await this.socket(signal);
		return this.call("startSemantic", undefined, signal) as Promise<Record<string, unknown>>;
	}
	async cancel(refreshId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		await this.socket(signal);
		return this.call("cancel", { refreshId }, signal) as Promise<Record<string, unknown>>;
	}
	async shutdown(): Promise<void> {
		this.#closed = true;
		this.#socket?.destroy();
		this.#socket = undefined;
		this.#generation = undefined;
	}
}
