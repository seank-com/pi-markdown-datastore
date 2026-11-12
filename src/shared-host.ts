import type { Server, Socket } from "node:net";
import { discoverQmdBinding, prepareQmdStateDirectory, QmdAdapter } from "./qmd-adapter.ts";
import { MetadataIndex, registerMetadata } from "./metadata-index.ts";
import type { MarkdownDatastoreConfig, StoreConfig } from "./config.ts";
import { DatastoreError } from "./errors.ts";
import { loadSharedCatalog, type SharedCatalog, type SharedStoreDefinition } from "./shared-catalog.ts";
import { attachSharedParser, encodeSharedMessage, generationId, listenOwnedSocket, parseSharedRequest, type SharedCall, type SharedHello, type SharedReply } from "./shared-ipc.ts";

export interface SharedHost {
	generation: string;
	catalog: SharedCatalog;
	adapters: ReadonlyMap<string, QmdAdapter>;
	close: () => Promise<void>;
}

function storeConfig(catalog: SharedCatalog, definition: SharedStoreDefinition): MarkdownDatastoreConfig {
	const store: StoreConfig = {
		name: definition.id, configuredRoot: definition.root, root: definition.root, rootWasSymlink: false,
		rootDev: definition.rootDev, rootIno: definition.rootIno, include: definition.include, exclude: definition.exclude,
		maxFileBytes: definition.maxFileBytes, search: definition.search,
	};
	return {
		schemaVersion: 1, projectRoot: catalog.stateRoot, configPath: catalog.path, stateRoot: `${catalog.stateRoot}/${definition.id}`,
		defaults: catalog.defaults,
		qmd: catalog.qmd, stores: new Map([[definition.id, store]]),
	};
}

export async function startSharedHost(catalogPath: string): Promise<SharedHost> {
	const catalog = await loadSharedCatalog(catalogPath);
	const generation = generationId();
	await prepareQmdStateDirectory(catalog.stateRoot);
	const adapters = new Map<string, QmdAdapter>();
	const sockets = new Set<Socket>();
	let server: Server | undefined;
	let closing: Promise<void> | undefined;
	const close = () => closing ??= (async () => {
		const currentServer = server;
		const stopped = currentServer ? new Promise<void>((resolve, reject) => currentServer.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())) : Promise.resolve();
		for (const socket of sockets) socket.destroy();
		await Promise.all([stopped, ...[...adapters.values()].map(adapter => adapter.shutdown())]);
	})();
	try {
		// Admission precedes endpoint changes; no workers or reconciliation run yet.
		for (const definition of catalog.stores.values()) {
			const config = storeConfig(catalog, definition);
			const adapter = new QmdAdapter(config, await discoverQmdBinding(config));
			try { await adapter.acquireOwnership(); }
			catch (error) { await adapter.shutdown(); throw error; }
			adapters.set(definition.id, adapter);
			registerMetadata(adapter.coordinator, new Map([[definition.id, new MetadataIndex(adapter.root)]]), config.stores);
		}
		server = await listenOwnedSocket(catalog.socketPath, (socket) => {
		sockets.add(socket);
		const waiters = new Map<string, AbortController>();
		const send = (reply: SharedReply) => { if (!socket.destroyed) socket.write(encodeSharedMessage(reply)); };
		const fail = (requestId: string | undefined, definitionRevision: string, error: unknown) => {
			const code = error instanceof DatastoreError ? error.code : "STORE_UNAVAILABLE";
			send({ version: 1, requestId, generation, definitionRevision, ok: false, error: { code } });
		};
		attachSharedParser(socket, (message) => {
			let request;
			try { request = parseSharedRequest(message); } catch (error) { fail(undefined, "", error); socket.destroy(); return; }
			if (request.operation === "drop") { waiters.get(request.requestId)?.abort(new DatastoreError("CANCELLED")); return; }
			void handle(request).catch((error) => fail(request.requestId, request.definitionRevision, error));
		}, () => socket.destroy());
		const handle = async (message: SharedHello | SharedCall): Promise<void> => {
			if (message.version !== 1 || typeof message.store !== "string" || typeof message.definitionRevision !== "string") throw new DatastoreError("CONFIG_INVALID");
			const definition = catalog.stores.get(message.store);
			const adapter = adapters.get(message.store);
			if (!definition || !adapter || message.definitionRevision !== definition.definitionRevision) throw new DatastoreError("STORE_UNAVAILABLE");
			if (message.operation === "hello") {
				send({ version: 1, requestId: message.requestId, generation, definitionRevision: definition.definitionRevision, ok: true, result: { generation, version: adapter.binding.version } });
				return;
			}
			const call = message as SharedCall;
			if (call.generation !== generation) throw new DatastoreError("STORE_UNAVAILABLE");
			const controller = new AbortController();
			if (call.requestId) waiters.set(call.requestId, controller);
			try {
				const store = adapter.config.stores.get(message.store)!;
				let result: unknown;
				if (call.operation === "activity") result = adapter.activity();
				else if (call.operation === "current") result = adapter.isLexicallyCurrent(message.store);
				else if (call.operation === "status") result = await adapter.status(controller.signal);
				else if (call.operation === "search") {
					const input = call.input ?? {};
					result = await adapter.search(store, String(input.query), input.mode as "lexical", Number(input.limit), input.minScore as number | undefined, controller.signal);
				}
				else if (call.operation === "startLexical") result = await adapter.startLexicalRefresh([store]);
				else if (call.operation === "startSemantic") result = await adapter.startSemanticRefresh([store]);
				else if (call.operation === "cancel") result = await adapter.cancelRefresh(String(call.input?.refreshId));
				else throw new DatastoreError("CAPABILITY_UNAVAILABLE");
				send({ version: 1, requestId: call.requestId, generation, definitionRevision: definition.definitionRevision, ok: true, result });
			} finally { if (call.requestId) waiters.delete(call.requestId); }
		};
		socket.on("close", () => {
			sockets.delete(socket);
			for (const controller of waiters.values()) controller.abort(new DatastoreError("CANCELLED"));
		});
	});
		for (const adapter of adapters.values()) void adapter.startupReconcile([...adapter.config.stores.values()]).catch(() => undefined);
	} catch (error) {
		await close();
		throw error;
	}
	return { generation, catalog, adapters, close };
}
