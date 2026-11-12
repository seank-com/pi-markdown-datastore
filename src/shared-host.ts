import type { Server, Socket } from "node:net";
import { join } from "node:path";
import { discoverQmdBinding, prepareQmdStateDirectory, qmdApplicationDirectory, QmdAdapter } from "./qmd-adapter.ts";
import { acquireIndexOwnership, type IndexOwnership } from "./index-ownership.ts";
import { adoptLegacyApplicationJobs, MaintenanceCoordinator, sourceDefinition } from "./maintenance-coordinator.ts";
import { MetadataIndex, registerMetadata, reconcileChanged, pageRendered, continuationOffset, continuationToken, tagCandidate } from "./metadata-index.ts";
import { clampReadBudget, type MarkdownDatastoreConfig, type StoreConfig } from "./config.ts";
import { DatastoreError } from "./errors.ts";
import { loadSharedCatalog, type SharedCatalog, type SharedStoreDefinition } from "./shared-catalog.ts";
import { attachSharedParser, encodeSharedMessage, generationId, listenOwnedSocket, parseSharedRequest, type SharedCall, type SharedHello, type SharedReply } from "./shared-ipc.ts";

export interface SharedHost {
	generation: string;
	catalog: SharedCatalog;
	adapters: ReadonlyMap<string, QmdAdapter>;
	coordinators: ReadonlyMap<string, MaintenanceCoordinator>;
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

export async function startSharedHost(catalogPath: string, options: { schedule?: typeof setTimeout } = {}): Promise<SharedHost> {
	const catalog = await loadSharedCatalog(catalogPath);
	const generation = generationId();
	await prepareQmdStateDirectory(catalog.stateRoot);
	const adapters = new Map<string, QmdAdapter>();
	const metadata = new Map<string, MetadataIndex>();
	const coordinators = new Map<string, MaintenanceCoordinator>();
	const ownerships = new Map<string, IndexOwnership>();
	const sockets = new Set<Socket>();
	let server: Server | undefined;
	let closing: Promise<void> | undefined;
	const close = () => closing ??= (async () => {
		const currentServer = server;
		const stopped = currentServer ? new Promise<void>((resolve, reject) => currentServer.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())) : Promise.resolve();
		for (const socket of sockets) socket.destroy();
		for (const coordinator of coordinators.values()) coordinator.shutdown();
		await Promise.all([...coordinators.values()].map((coordinator) => coordinator.settled()));
		await Promise.all([...ownerships.values()].map((ownership) => ownership.release()));
		await Promise.all([stopped, ...[...adapters.values()].map(adapter => adapter.shutdown())]);
	})();
	try {
		// Admission precedes endpoint changes; no workers or reconciliation run yet.
		for (const definition of catalog.stores.values()) {
			const config = storeConfig(catalog, definition);
			let coordinator!: MaintenanceCoordinator;
			const stateDirectory = `${catalog.stateRoot}/${definition.id}`;
			await prepareQmdStateDirectory(stateDirectory);
			ownerships.set(definition.id, await acquireIndexOwnership(stateDirectory));
			await adoptLegacyApplicationJobs(stateDirectory, `${stateDirectory}/jobs.json`, new Set([definition.id]), (version) => qmdApplicationDirectory(config, version), (job, version) => sourceDefinition(job.stores.map((name) => config.stores.get(name)!), job.mode === "metadata" ? undefined : { version }));
			coordinator = new MaintenanceCoordinator(`${stateDirectory}/jobs.json`, () => new Set([definition.id]), (job) => sourceDefinition(job.stores.map((name) => config.stores.get(name)!), job.mode === "metadata" ? undefined : { version: adapters.get(definition.id)?.binding.version ?? "" }));
			if (config.qmd.enabled) {
				try {
					const adapter = new QmdAdapter(config, await discoverQmdBinding(config), coordinator);
					try { await adapter.acquireOwnership(); }
					catch (error) { await adapter.shutdown(); throw error; }
					adapters.set(definition.id, adapter);
				} catch { /* graph work continues on the same coordinator */ }
			}
			coordinators.set(definition.id, coordinator);
			const index = new MetadataIndex(stateDirectory);
			metadata.set(definition.id, index);
			registerMetadata(coordinator, new Map([[definition.id, index]]), config.stores);
			coordinator.startCycle(() => reconcileChanged(coordinator, new Map([[definition.id, index]]), config.stores), undefined, options.schedule);
			await coordinator.ensureLoaded();
			coordinator.relaunchQueued();
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
			const index = metadata.get(message.store);
			const coordinator = coordinators.get(message.store);
			if (!definition || !index || !coordinator || message.definitionRevision !== definition.definitionRevision) throw new DatastoreError("STORE_UNAVAILABLE");
			if (message.operation === "hello") {
				send({ version: 1, requestId: message.requestId, generation, definitionRevision: definition.definitionRevision, ok: true, result: { generation, version: adapter?.binding.version ?? "metadata" } });
				return;
			}
			const call = message as SharedCall;
			if (call.generation !== generation) throw new DatastoreError("STORE_UNAVAILABLE");
			const controller = new AbortController();
			if (call.requestId) waiters.set(call.requestId, controller);
			try {
				const store = adapter?.config.stores.get(message.store);
				let result: unknown;
				if (call.operation === "startMetadata") { const paths = Array.isArray(call.input?.paths) ? call.input.paths.filter((path): path is string => typeof path === "string") : []; if (call.input?.rebuild === true && paths.length) throw new DatastoreError("INVALID_NOTE_REF"); if (paths.length) coordinator.notePaths(message.store, paths); result = await coordinator.enqueue("metadata", [message.store], "explicit-maintenance", sourceDefinition([storeConfig(catalog, definition).stores.get(message.store)!]), call.input?.rebuild === true ? "rebuild" : undefined); }
				else if (call.operation === "links" || call.operation === "backlinks" || call.operation === "tagPages" || call.operation === "tags") {
					const store = storeConfig(catalog, definition).stores.get(message.store);
					if (!store) throw new DatastoreError("STORE_UNAVAILABLE");
					const snapshot = await index.requireSnapshot();
					const budget = clampReadBudget({ maxBytes: call.input?.maxBytes, maxLines: call.input?.maxLines }, { maxBytes: catalog.defaults.maxResultBytes, maxLines: catalog.defaults.maxResultLines });
					const responseStore = typeof call.input?.responseStore === "string" ? call.input.responseStore : message.store;
					if (call.operation === "tags") {
						const offset = continuationOffset(typeof call.input?.continuation === "string" ? call.input.continuation : undefined, responseStore, snapshot.revision, "catalog");
						const catalog = await index.catalog();
						const render = (items: typeof catalog) => ({ tags: items.map((tag) => ({ identity: tag.identity, spelling: tag.spelling, pageCount: tag.pages.length })), total: catalog.length, returned: items.length, revision: snapshot.revision });
						const page = pageRendered(catalog, offset, budget, render);
						const admitted = await index.admit(store, [], controller.signal);
						result = { ...render(page.items), complete: admitted.current, diagnostics: admitted.diagnostics, continuation: page.next === undefined ? undefined : continuationToken(responseStore, snapshot.revision, "catalog", page.next, budget) };
					} else if (call.operation === "tagPages") {
						const tag = String(call.input?.tag);
						const pages = await index.tagPages(tag);
						const limit = Number(call.input?.limit ?? 20);
						if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
						const offset = continuationOffset(typeof call.input?.continuation === "string" ? call.input.continuation : undefined, responseStore, snapshot.revision, tag);
						const window = pages.slice(0, offset + limit);
						const revisionOf = (path: string) => index.fileRevision(path, snapshot);
						if (pages.some((path) => !revisionOf(path))) throw new DatastoreError("STALE_INDEX");
						const render = (items: string[]) => ({ candidates: items.map((path) => tagCandidate(responseStore, path, revisionOf(path)!)), examined: pages.length, partial: offset + items.length < pages.length, revision: snapshot.revision });
						const page = pageRendered(window, offset, budget, render);
						const next = offset + page.items.length < pages.length ? offset + page.items.length : undefined;
						const admitted = await index.admit(store, page.items.map((path) => ({ path, kind: "note" as const })), controller.signal);
						result = { ...render(page.items), complete: admitted.current, diagnostics: admitted.diagnostics, continuation: next === undefined ? undefined : continuationToken(responseStore, snapshot.revision, tag, next, budget) };
					} else {
						const path = String(call.input?.path);
						const edges = call.operation === "links" ? await index.links(path) : await index.backlinks(path);
						const query = `${call.operation}:${path}`;
						const offset = continuationOffset(typeof call.input?.continuation === "string" ? call.input.continuation : undefined, responseStore, snapshot.revision, query);
						const pageCount = new Set(edges.map((edge) => call.operation === "links" ? edge.target : edge.source)).size;
						const render = (items: typeof edges) => ({ edges: items, pageCount, occurrenceCount: edges.length, returned: items.length, complete: snapshot.complete, revision: snapshot.revision });
						const page = pageRendered(edges, offset, budget, render);
						const subject = { path, kind: call.operation === "backlinks" && !path.endsWith(".md") ? "attachment" as const : "note" as const };
						const admitted = await index.admit(store, [subject, ...page.items.flatMap((edge) => [{ path: edge.source, kind: "note" as const }, ...(edge.targetKind === "note" || edge.targetKind === "attachment" ? [{ path: edge.target, kind: edge.targetKind }] : [])])], controller.signal);
						result = { ...render(page.items), complete: admitted.current, diagnostics: admitted.diagnostics, continuation: page.next === undefined ? undefined : continuationToken(responseStore, snapshot.revision, query, page.next, budget) };
					}
				}
				else if (call.operation === "activity" || call.operation === "status" || call.operation === "current") {
					await coordinator.ensureLoaded();
					const jobs = coordinator.jobs().filter((job) => job.mode === "metadata" && job.stores.includes(message.store));
					const running = jobs.find((job) => job.state === "running");
					const queued = jobs.find((job) => job.state === "queued");
					const snapshot = await index.snapshot();
					const metadata = { state: !snapshot ? "unavailable" : snapshot.complete ? "ready" : "stale", revision: snapshot?.revision, complete: snapshot?.complete ?? false, progress: { state: running ? "running" : queued ? "queued" : "idle", active: Boolean(running), queued: Boolean(queued), job: running ?? queued ?? jobs[0] } };
					if (call.operation === "current") result = adapter ? adapter.isLexicallyCurrent(message.store) : false;
					else if (!adapter) result = call.operation === "activity" ? { state: metadata.progress.state, active: metadata.progress.active, queued: metadata.progress.queued, embeddingActive: false, jobs } : { state: "unavailable", reasonCode: "BACKEND_MISSING", metadata, refresh: metadata.progress };
					else if (call.operation === "activity") result = { ...adapter.activity(), metadata };
					else result = { ...await adapter.status(controller.signal), metadata };
				}
				else if (!adapter || !store) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
				else if (call.operation === "search") {
					const input = call.input ?? {};
					result = await adapter.search(store, String(input.query), input.mode as "lexical", Number(input.limit), input.minScore as number | undefined, controller.signal);
				}
				else if (call.operation === "startLexical") result = await adapter.startLexicalRefresh([store]);
				else if (call.operation === "startSemantic") result = await adapter.startSemanticRefresh([store]);
				else if (call.operation === "cancel") result = adapter ? await adapter.cancelRefresh(String(call.input?.refreshId)) : await coordinator.cancel(String(call.input?.refreshId));
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
	return { generation, catalog, adapters, coordinators, close };
}
