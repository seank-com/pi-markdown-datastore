import type { Server, Socket } from "node:net";
import { dirname, join } from "node:path";
import { discoverQmdBinding, prepareQmdStateDirectory, qmdApplicationDirectory, QmdAdapter } from "./qmd-adapter.ts";
import { acquireIndexOwnership, type IndexOwnership } from "./index-ownership.ts";
import { adoptLegacyApplicationJobs, MaintenanceCoordinator, sourceDefinition } from "./maintenance-coordinator.ts";
import { MetadataIndex, registerMetadata, reconcileChanged, pageRendered, continuationOffset, continuationToken, tagCandidate } from "./metadata-index.ts";
import type { MarkdownDatastoreConfig, StoreConfig } from "./config.ts";
import { clampReadBudget } from "./config-common.ts";
import { assertRootIdentity, validateRelativeContainedPath } from "./containment.ts";
import { DatastoreError } from "./errors.ts";
import type { SharedHostState, SharedStoreDefinition } from "./shared-config.ts";
import { loadDeclarationHostSettings, loadRegistrations } from "./shared-registrations.ts";
import { attachSharedParser, encodeSharedMessage, generationId, listenOwnedSocket, parseSharedRequest, type SharedCall, type SharedReply } from "./shared-ipc.ts";

export interface SharedHost {
	generation: string;
	state: SharedHostState;
	adapters: ReadonlyMap<string, QmdAdapter>;
	coordinators: ReadonlyMap<string, MaintenanceCoordinator>;
	close: () => Promise<void>;
}

export function sharedStoreConfig(host: SharedHostState, definition: SharedStoreDefinition): MarkdownDatastoreConfig {
	const store: StoreConfig = {
		name: definition.id, configuredRoot: definition.root, root: definition.root, rootWasSymlink: false,
		rootDev: definition.rootDev, rootIno: definition.rootIno, include: definition.include, exclude: definition.exclude,
		maxFileBytes: definition.maxFileBytes, search: definition.search,
	};
	return {
		schemaVersion: 1, projectRoot: host.stateRoot, configPath: host.path, stateRoot: `${host.stateRoot}/${definition.id}`,
		defaults: host.defaults,
		qmd: host.qmd, stores: new Map([[definition.id, store]]),
	};
}

export async function startSharedHost(hostConfigPath: string, options: { schedule?: typeof setTimeout } = {}): Promise<SharedHost> {
	const settings = await loadDeclarationHostSettings(hostConfigPath);
	const registryOwner = await acquireIndexOwnership(dirname(settings.path));
	const { registry, state } = await (async () => {
		try {
			const registry = await loadRegistrations(settings);
			await prepareQmdStateDirectory(registry.state.stateRoot);
			return { registry, state: registry.state };
		} catch (error) { await registryOwner?.release(); throw error; }
	})();
	const generation = generationId();
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
		await registry?.settled();
		await Promise.allSettled(initializing.values());
		for (const coordinator of coordinators.values()) coordinator.shutdown();
		await Promise.all([...coordinators.values()].map((coordinator) => coordinator.settled()));
		await Promise.all([...ownerships.values()].map((ownership) => ownership.release()));
		try { await Promise.all([stopped, ...[...adapters.values()].map(adapter => adapter.shutdown())]); }
		finally { await registryOwner?.release(); }
	})();
	const initializing = new Map<string, Promise<void>>();
	const configs = new Map<string, MarkdownDatastoreConfig>();
	const admit = async (id: string): Promise<void> => {
		if (closing) throw new DatastoreError("STORE_UNAVAILABLE");
		const pending = initializing.get(id); if (pending) return pending;
		const operation = (async () => {
			const definition = state.stores.get(id) ?? await state.unavailableStores.get(id)?.();
			if (!definition) throw new DatastoreError("STORE_UNKNOWN");
			let config = configs.get(id);
			if (!config) { config = sharedStoreConfig(state, definition); configs.set(id, config); }
			await assertRootIdentity(config.stores.get(id)!).catch(() => { throw new DatastoreError("STORE_UNAVAILABLE", { sourceRoot: true }); });
			if (coordinators.has(id)) return;
			if (closing) throw new DatastoreError("STORE_UNAVAILABLE");
			let coordinator!: MaintenanceCoordinator;
			try {
			const stateDirectory = `${state.stateRoot}/${definition.id}`;

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
			if (closing) throw new DatastoreError("STORE_UNAVAILABLE");
			coordinator.relaunchQueued();
			if (server) { const adapter = adapters.get(id); if (adapter) void adapter.startupReconcile([...config.stores.values()]).catch(() => undefined); }
			} catch (error) {
				coordinator?.shutdown(); await coordinator?.settled();
				await adapters.get(id)?.shutdown(); await ownerships.get(id)?.release();
				coordinators.delete(id); metadata.delete(id); adapters.delete(id); ownerships.delete(id);
				throw error;
			}
		})();
		initializing.set(id, operation);
		try { await operation; } finally { initializing.delete(id); }
	};
	try {
		// Admit only bound members before endpoint publication. Missing members are admitted on demand.
		for (const definition of state.stores.values()) {
			try { await admit(definition.id); } catch (error) { if (!(error instanceof DatastoreError) || error.code !== "STORE_UNAVAILABLE" || error.details?.sourceRoot !== true) throw error; }
		}
		server = await listenOwnedSocket(state.socketPath, (socket) => {
		sockets.add(socket);
		const waiters = new Map<string, AbortController>();
		const send = (reply: SharedReply) => { if (!socket.destroyed) socket.write(encodeSharedMessage(reply)); };
		const fail = (requestId: string | undefined, definitionRevision: string, error: unknown) => {
			const code = error instanceof DatastoreError ? error.code : "STORE_UNAVAILABLE";
			const applied = error instanceof DatastoreError && error.details?.operationApplied === true;
			const refreshIds = applied && Array.isArray(error.details?.refreshIds) ? error.details.refreshIds.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{32}$/.test(id)) : [];
			const conflicts = error instanceof DatastoreError && Array.isArray(error.details?.conflictingFields) ? error.details.conflictingFields : undefined;
			send({ version: 1, requestId, generation, definitionRevision, ok: false, error: { code, ...(applied ? { details: { operationApplied: true, refreshIds } } : conflicts ? { details: { conflictingFields: conflicts } } : {}) } });
		};
		attachSharedParser(socket, (message) => {
			let request;
			try { request = parseSharedRequest(message); } catch (error) { fail(undefined, "", error); socket.destroy(); return; }
			if (request.operation === "drop") { waiters.get(request.requestId)?.abort(new DatastoreError("CANCELLED")); return; }
			if (request.operation === "helloDeclaration") {
				const hello = request;
				void (async () => {
					if (!registry) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
					if (closing) throw new DatastoreError("STORE_UNAVAILABLE");
					const definition = await registry.register(hello.declaration, hello);
					await admit(definition.id);
					const version = adapters.get(definition.id)?.binding.version ?? "metadata";
					send({ version: 1, requestId: hello.requestId, generation, definitionRevision: definition.definitionRevision, ok: true, result: { generation, version, resultBudgetVersion: 1, store: definition.id } });
				})().catch(error => fail(hello.requestId, "", error));
				return;
			}
			void handle(request).catch((error) => fail(request.requestId, request.definitionRevision, error));
		}, () => socket.destroy());
		const handle = async (message: SharedCall): Promise<void> => {
			if (message.version !== 1 || typeof message.store !== "string" || typeof message.definitionRevision !== "string") throw new DatastoreError("CONFIG_INVALID");
			await admit(message.store);
			const definition = state.stores.get(message.store);
			const adapter = adapters.get(message.store);
			const index = metadata.get(message.store);
			const coordinator = coordinators.get(message.store);
			if (!definition || !index || !coordinator || message.definitionRevision !== definition.definitionRevision) throw new DatastoreError("STORE_UNAVAILABLE");
			const call = message as SharedCall;
			if (call.generation !== generation) throw new DatastoreError("STORE_UNAVAILABLE");
			const controller = new AbortController();
			if (call.requestId) waiters.set(call.requestId, controller);
			try {
				const store = adapter?.config.stores.get(message.store);
				let result: unknown;
				if (call.operation === "startMetadata") {
					if (call.input?.paths !== undefined && (!Array.isArray(call.input.paths) || call.input.paths.length === 0 || call.input.paths.some((path) => typeof path !== "string"))) throw new DatastoreError("INVALID_NOTE_REF");
					const paths = Array.isArray(call.input?.paths) ? call.input.paths.map((path) => validateRelativeContainedPath(path as string)) : [];
					if (call.input?.rebuild === true && paths.length) throw new DatastoreError("INVALID_NOTE_REF");
					if (paths.length) coordinator.notePaths(message.store, paths);
					result = await coordinator.enqueue("metadata", [message.store], "explicit-maintenance", sourceDefinition([sharedStoreConfig(state, definition).stores.get(message.store)!]), call.input?.rebuild === true || call.input?.paths === undefined ? "rebuild" : undefined);
				}
				else if (call.operation === "links" || call.operation === "backlinks" || call.operation === "tagPages" || call.operation === "tags") {
					const store = sharedStoreConfig(state, definition).stores.get(message.store);
					if (!store) throw new DatastoreError("STORE_UNAVAILABLE");
					const snapshot = await index.requireSnapshot();
					const budget = clampReadBudget({ maxBytes: call.input?.maxBytes, maxLines: call.input?.maxLines }, { maxBytes: state.defaults.maxResultBytes, maxLines: state.defaults.maxResultLines });
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
				else if (call.operation === "cancel") result = adapter ? await adapter.cancelRefresh(String(call.input?.refreshId)) : await coordinator.cancel(String(call.input?.refreshId));
				else if (!adapter || !store) throw new DatastoreError("CAPABILITY_UNAVAILABLE");
				else if (call.operation === "search") {
					const input = call.input ?? {};
					result = await adapter.search(store, String(input.query), input.mode as "lexical", Number(input.limit), input.minScore as number | undefined, controller.signal);
				}
				else if (call.operation === "startLexical") result = await adapter.startLexicalRefresh([store]);
				else if (call.operation === "startSemantic") result = await adapter.startSemanticRefresh([store]);
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
	return { generation, state, adapters, coordinators, close };
}
