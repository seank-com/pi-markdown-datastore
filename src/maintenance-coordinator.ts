import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { acquireIndexOwnership } from "./index-ownership.ts";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import type { QmdRefreshJob, QmdRefreshPhase } from "./qmd-adapter.ts";
import type { QmdWorkerProgress } from "./qmd-worker-client.ts";

const TERMINAL_JOB_LIMIT = 20;
type Mode = "lexical" | "semantic" | "metadata";
export type MaintenanceReport = (phase: QmdRefreshPhase, update?: QmdWorkerProgress | { documentsCompleted: number; sourceBytesCompleted: number; documentsTotal?: number; sourceBytesTotal?: number }) => void;
export type MaintenanceRunner = (job: QmdRefreshJob, signal: AbortSignal, report: MaintenanceReport) => Promise<{ generation?: string } | void>;

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
	await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
	const handle = await open(temp, constants.O_RDONLY);
	await handle.sync();
	await handle.close();
	await rename(temp, path);
	await chmod(path, 0o600);
}

/** Existing queue, receipt file, coalescing and cancellation. Backends register runners; they do not keep another queue. */
export function sourceDefinition(stores: { name: string; root: string; rootDev: number; rootIno: number; include: readonly string[]; exclude: readonly string[]; maxFileBytes: number; search?: { qmdCollection?: string } }[], backend?: { version: string }): string {
	return createHash("sha256").update(JSON.stringify({ stores: [...stores].sort((left, right) => left.name.localeCompare(right.name)).map((store) => ({ name: store.name, root: store.root, rootDev: store.rootDev, rootIno: store.rootIno, include: [...store.include], exclude: [...store.exclude], maxFileBytes: store.maxFileBytes, qmdCollection: backend ? store.search?.qmdCollection : undefined })), backend: backend?.version })).digest("hex");
}

export async function adoptLegacyApplicationJobs(stateRoot: string, stablePath: string, knownStores: ReadonlySet<string>, expectedDirectory: (version: string) => string, identityFor?: (job: { mode: string; stores: string[] }, version: string) => string): Promise<void> {
	try { await lstat(stablePath); return; } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
	const names = await readdir(stateRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
	const matches: { directory: string; path: string }[] = [];
	for (const name of names) {
		const parsed = /^qmd-public-(.+)-([0-9a-f]{16})$/.exec(name);
		if (!parsed) continue;
		const directory = join(stateRoot, name);
		const info = await lstat(directory).catch(() => undefined);
		if (!info?.isDirectory() || info.isSymbolicLink()) continue;
		const path = join(directory, "jobs.json");
		const file = await lstat(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
		if (!file) continue;
		if (directory !== expectedDirectory(parsed[1])) throw new DatastoreError("INDEX_CORRUPT");
		matches.push({ directory, path });
	}
	if (matches.length > 1) throw new DatastoreError("INDEX_CORRUPT");
	if (matches.length !== 1) return;
	const lease = await acquireIndexOwnership(matches[0].directory);
	try {
		const file = await lstat(matches[0].path);
		if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || file.size > 256 * 1024) throw new DatastoreError("INDEX_CORRUPT");
		const temp = `${stablePath}.adopting-${randomBytes(8).toString("hex")}`;
		await copyFile(matches[0].path, temp);
		const probe = new MaintenanceCoordinator(temp, () => knownStores);
		try { await probe.ensureLoaded(); if (identityFor) await probe.stampMissingDefinition(identityFor, basename(matches[0].directory).slice("qmd-public-".length, -17)); probe.shutdown(); await rename(temp, stablePath); }
		catch (error) { probe.shutdown(); await rm(temp, { force: true }).catch(() => undefined); throw error; }
	} finally { await lease.release(); }
}

export class MaintenanceCoordinator {
	#jobs = new Map<string, QmdRefreshJob>();
	#controllers = new Map<string, AbortController>();
	#admissions = new Map<string, Promise<void>>();
	#persisted = new Map<string, Promise<void>>();
	#settlePersist = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
	#runners = new Map<Mode, MaintenanceRunner>();
	#loaded = false;
	#loading?: Promise<void>;
	#tail: Promise<void> = Promise.resolve();
	#persistTail: Promise<void> = Promise.resolve();
	#closed = false;
	#hostClosing = false;
	#explicitCancel = new Set<string>();
	#pendingPaths = new Map<string, Set<string>>();
	readonly jobsPath: string;
	readonly knownStores: () => ReadonlySet<string>;
	readonly definitionFor?: (job: { mode: string; stores: string[] }) => string;
	constructor(jobsPath: string, knownStores: () => ReadonlySet<string>, definitionFor?: (job: { mode: string; stores: string[] }) => string) { this.jobsPath = jobsPath; this.knownStores = knownStores; this.definitionFor = definitionFor; }
	register(mode: Mode, runner: MaintenanceRunner): void { this.#runners.set(mode, runner); }
	hasRunner(mode: Mode): boolean { return this.#runners.has(mode); }
	notePaths(store: string, paths: string[]): void { const set = this.#pendingPaths.get(store) ?? new Set<string>(); for (const path of paths) set.add(path); this.#pendingPaths.set(store, set); }
	takePaths(store: string): string[] { const set = this.#pendingPaths.get(store); this.#pendingPaths.delete(store); return set ? [...set] : []; }
	startCycle(run: () => Promise<void>, intervalMs = 300_000, schedule: typeof setTimeout = setTimeout): void {
		const arm = () => { const timer = schedule(() => { void run().finally(arm); }, intervalMs); timer.unref?.(); };
		arm();
	}
	jobs(): QmdRefreshJob[] { return [...this.#jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((job) => structuredClone(job)); }
	get(refreshId: string): QmdRefreshJob | undefined { return this.#jobs.get(refreshId); }
	async ensureLoaded(): Promise<void> {
		if (this.#loaded) return;
		if (this.#loading) return this.#loading;
		this.#loading = this.load();
		try { await this.#loading; } finally { this.#loading = undefined; }
	}
	private async load(): Promise<void> {
		let raw: any;
		try {
			const info = await lstat(this.jobsPath);
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 256 * 1024) throw new DatastoreError("INDEX_CORRUPT");
			raw = JSON.parse(await readFile(this.jobsPath, "utf8"));
		} catch (error: any) {
			if (error?.code !== "ENOENT") { if (error instanceof DatastoreError) throw error; throw new DatastoreError("INDEX_CORRUPT"); }
			raw = { version: 1, jobs: [] };
		}
		if (raw?.version !== 1 || !Array.isArray(raw.jobs) || raw.jobs.length > TERMINAL_JOB_LIMIT) throw new DatastoreError("INDEX_CORRUPT");
		for (const value of raw.jobs) {
			const jobRaw = value as Record<string, unknown>;
			const allowed = ["version", "refreshId", "key", "mode", "stores", "ownership", "state", "phase", "createdAt", "updatedAt", "completedAt", "generation", "errorCode", "definition", "progress"];
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(jobRaw).some((key) => !allowed.includes(key)) || jobRaw.version !== 1 || typeof jobRaw.refreshId !== "string" || !/^[0-9a-f]{32}$/.test(jobRaw.refreshId) || !["lexical", "semantic", "metadata"].includes(String(jobRaw.mode)) || !Array.isArray(jobRaw.stores) || jobRaw.stores.some((name) => typeof name !== "string" || !this.knownStores().has(name)) || new Set(jobRaw.stores as string[]).size !== jobRaw.stores.length || !["startup-reconciliation", "explicit-maintenance"].includes(String(jobRaw.ownership)) || !["queued", "running", "succeeded", "failed", "cancelled"].includes(String(jobRaw.state)) || !["queued", "scanning", "updating", "embedding", "validating", "promoting", "succeeded", "failed", "cancelled"].includes(String(jobRaw.phase)) || typeof jobRaw.createdAt !== "string" || typeof jobRaw.updatedAt !== "string") throw new DatastoreError("INDEX_CORRUPT");
			const stores = [...jobRaw.stores as string[]].sort();
			const mode = String(jobRaw.mode) as Mode;
			if (jobRaw.key !== `${mode}:${stores.join(",")}`) throw new DatastoreError("INDEX_CORRUPT");
			if (jobRaw.completedAt !== undefined && typeof jobRaw.completedAt !== "string") throw new DatastoreError("INDEX_CORRUPT");
			if (jobRaw.errorCode !== undefined && (typeof jobRaw.errorCode !== "string" || !/^[A-Z_]{3,64}$/.test(jobRaw.errorCode))) throw new DatastoreError("INDEX_CORRUPT");
			const generationPattern = mode === "metadata" ? /^(?:gen|meta)-[0-9a-f]{32}$/ : /^gen-[0-9a-f]{32}$/;
			if (jobRaw.generation !== undefined && (typeof jobRaw.generation !== "string" || !generationPattern.test(jobRaw.generation))) throw new DatastoreError("INDEX_CORRUPT");
			if (jobRaw.definition !== undefined && (typeof jobRaw.definition !== "string" || !/^[0-9a-f]{64}$/.test(jobRaw.definition))) throw new DatastoreError("INDEX_CORRUPT");
			const progressRaw = jobRaw.progress as Record<string, unknown>;
			const progressAllowed = ["documentsCompleted", "documentsTotal", "sourceBytesCompleted", "sourceBytesTotal", "chunksCompleted", "chunksTotal", "embeddingBytesCompleted", "embeddingBytesTotal", "errors"];
			if (!progressRaw || typeof progressRaw !== "object" || Array.isArray(progressRaw) || Object.keys(progressRaw).some((field) => !progressAllowed.includes(field))) throw new DatastoreError("INDEX_CORRUPT");
			for (const field of progressAllowed) if (progressRaw[field] !== undefined && (!Number.isSafeInteger(progressRaw[field]) || (progressRaw[field] as number) < 0)) throw new DatastoreError("INDEX_CORRUPT");
			const job: QmdRefreshJob = { version: 1, refreshId: jobRaw.refreshId, key: jobRaw.key, mode, stores, ownership: jobRaw.ownership as QmdRefreshJob["ownership"], state: jobRaw.state as QmdRefreshJob["state"], phase: jobRaw.phase as QmdRefreshPhase, createdAt: jobRaw.createdAt, updatedAt: jobRaw.updatedAt, completedAt: typeof jobRaw.completedAt === "string" ? jobRaw.completedAt : undefined, generation: typeof jobRaw.generation === "string" ? jobRaw.generation : undefined, errorCode: typeof jobRaw.errorCode === "string" ? jobRaw.errorCode : undefined, definition: typeof jobRaw.definition === "string" ? jobRaw.definition : undefined, progress: { documentsCompleted: Number(progressRaw.documentsCompleted ?? 0), documentsTotal: progressRaw.documentsTotal as number | undefined, sourceBytesCompleted: Number(progressRaw.sourceBytesCompleted ?? 0), sourceBytesTotal: progressRaw.sourceBytesTotal as number | undefined, chunksCompleted: Number(progressRaw.chunksCompleted ?? 0), chunksTotal: progressRaw.chunksTotal as number | undefined, embeddingBytesCompleted: Number(progressRaw.embeddingBytesCompleted ?? 0), embeddingBytesTotal: progressRaw.embeddingBytesTotal as number | undefined, errors: Number(progressRaw.errors ?? 0) } };
			if (job.state === "queued" || job.state === "running") { job.state = "queued"; job.phase = "queued"; delete job.errorCode; delete job.completedAt; job.updatedAt = new Date().toISOString(); }
			this.#jobs.set(job.refreshId, job);
		}
		this.#loaded = true;
		if (this.#jobs.size) await this.persist();
	}
	private persist(): Promise<void> {
		const terminal = this.jobs().filter((job) => !["queued", "running"].includes(job.state)).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
		while (this.#jobs.size > TERMINAL_JOB_LIMIT && terminal.length) this.#jobs.delete(terminal.shift()!.refreshId);
		const write = this.#persistTail.catch(() => undefined).then(() => atomicJson(this.jobsPath, { version: 1, jobs: this.jobs() }));
		this.#persistTail = write;
		return write;
	}
	async enqueue(mode: Mode, stores: string[], ownership: QmdRefreshJob["ownership"], definition?: string): Promise<Record<string, unknown>> {
		if (this.#closed) throw new DatastoreError("CANCELLED");
		await this.ensureLoaded();
		if (this.#closed) throw new DatastoreError("CANCELLED");
		const ordered = [...stores].sort();
		const current = this.definitionFor?.({ mode, stores: ordered });
		if (definition !== undefined && current !== undefined && definition !== current) throw new DatastoreError("STALE_INDEX");
		definition ??= current;
		const key = `${mode}:${ordered.join(",")}`;
		const inflight = this.#admissions.get(key);
		if (inflight) {
			await inflight;
			if (this.#closed) throw new DatastoreError("CANCELLED");
			const admitted = [...this.#jobs.values()].find((job) => job.key === key && (job.state === "queued" || job.state === "running") && job.definition === definition);
			if (!admitted) throw new DatastoreError("INDEX_CORRUPT");
			this.launch(admitted);
			return { ...structuredClone(admitted), coalesced: true };
		}
		const existing = [...this.#jobs.values()].find((job) => job.key === key && (job.state === "queued" || job.state === "running") && job.definition === definition);
		if (existing) { this.launch(existing); return { ...structuredClone(existing), coalesced: true }; }
		let admit!: () => void;
		let refuse!: (error: unknown) => void;
		const admission = new Promise<void>((resolve, reject) => { admit = resolve; refuse = reject; });
		admission.catch(() => undefined);
		this.#admissions.set(key, admission);
		try {
			const terminal = this.jobs().filter((item) => !["queued", "running"].includes(item.state));
			while (this.#jobs.size + 1 > TERMINAL_JOB_LIMIT && terminal.length) this.#jobs.delete(terminal.shift()!.refreshId);
			if (this.#jobs.size + 1 > TERMINAL_JOB_LIMIT) throw new DatastoreError("RESULT_LIMIT_EXCEEDED");
			const now = new Date().toISOString();
			const job: QmdRefreshJob = { version: 1, refreshId: randomBytes(16).toString("hex"), key, mode, stores: ordered, ownership, definition, state: "queued", phase: "queued", createdAt: now, updatedAt: now, progress: { documentsCompleted: 0, sourceBytesCompleted: 0, chunksCompleted: 0, embeddingBytesCompleted: 0, errors: 0 } };
			this.#jobs.set(job.refreshId, job);
			try { await this.persist(); } catch (error) { this.#jobs.delete(job.refreshId); throw error; }
			admit();
			this.launch(job);
			return { ...structuredClone(job), coalesced: false };
		} catch (error) { refuse(error); throw error; } finally { this.#admissions.delete(key); }
	}
	relaunchQueued(): void { for (const job of this.#jobs.values()) if (job.state === "queued") this.launch(job); }
	private launch(job: QmdRefreshJob): void {
		if (this.#closed || this.#controllers.has(job.refreshId) || job.state !== "queued") return;
		if (this.definitionFor && job.definition !== this.definitionFor(job)) return;
		const mode = job.mode;
		const runner = this.#runners.get(mode);
		if (!runner) return;
		const controller = new AbortController();
		this.#controllers.set(job.refreshId, controller);
		const previous = this.#tail;
		const operation = (async () => {
			await previous.catch(() => undefined);
			throwIfAborted(controller.signal);
			job.state = "running"; job.phase = "scanning"; job.updatedAt = new Date().toISOString();
			const report: MaintenanceReport = (phase, update) => {
				if (["succeeded", "failed", "cancelled"].includes(job.phase)) return;
				job.phase = phase; job.state = phase === "queued" ? "queued" : "running"; job.updatedAt = new Date().toISOString();
				if (update && "documentsCompleted" in update) { job.progress.documentsCompleted = update.documentsCompleted; job.progress.sourceBytesCompleted = update.sourceBytesCompleted; if (update.documentsTotal !== undefined) job.progress.documentsTotal = update.documentsTotal; if (update.sourceBytesTotal !== undefined) job.progress.sourceBytesTotal = update.sourceBytesTotal; }
				else if (update) { if (update.documents) { job.progress.documentsCompleted = update.documents.completed; job.progress.documentsTotal = update.documents.total; } if (update.chunks) { job.progress.chunksCompleted = update.chunks.completed; job.progress.chunksTotal = update.chunks.total; } if (update.bytes) { job.progress.embeddingBytesCompleted = update.bytes.completed; job.progress.embeddingBytesTotal = update.bytes.total; } if (update.errors !== undefined) job.progress.errors = update.errors; }
			};
			const result = await runner(job, controller.signal, report);
			job.state = "succeeded"; job.phase = "succeeded"; if (result && "generation" in result && result.generation) job.generation = result.generation;
		})().catch((error: unknown) => {
			if (this.#hostClosing && !this.#explicitCancel.has(job.refreshId)) { job.state = "queued"; job.phase = "queued"; delete job.errorCode; delete job.completedAt; return; }
			const safe = error instanceof DatastoreError ? error : new DatastoreError("BACKEND_FAILED");
			job.state = safe.code === "CANCELLED" ? "cancelled" : "failed";
			job.phase = job.state; job.errorCode = safe.code;
		}).finally(async () => {
			if (job.mode === "metadata" && ["succeeded", "failed", "cancelled"].includes(job.state)) for (const store of job.stores) if (this.#pendingPaths.get(store)?.size) void this.enqueue("metadata", [store], job.ownership);
			job.updatedAt = new Date().toISOString();
			if (["succeeded", "failed", "cancelled"].includes(job.state)) job.completedAt ??= job.updatedAt;
			this.#controllers.delete(job.refreshId);
			if (["succeeded", "failed", "cancelled"].includes(job.state)) {
				try { await this.persist(); this.#finish(job.refreshId); }
				catch (error) { job.state = "failed"; job.phase = "failed"; job.errorCode = "INDEX_CORRUPT"; job.completedAt = job.updatedAt; this.#fail(job.refreshId, error); }
			}
		});
		this.#tail = operation.then(() => undefined, () => undefined);
	}
	async cancel(refreshId: string): Promise<Record<string, unknown>> {
		await this.ensureLoaded();
		const job = this.#jobs.get(refreshId);
		if (!job) throw new DatastoreError("INVALID_NOTE_REF");
		const controller = this.#controllers.get(refreshId);
		this.#explicitCancel.add(refreshId);
		controller?.abort(new DatastoreError("CANCELLED"));
		if (job.state === "queued") { job.state = "cancelled"; job.phase = "cancelled"; job.errorCode = "CANCELLED"; job.updatedAt = new Date().toISOString(); job.completedAt = job.updatedAt; try { await this.persist(); this.#finish(refreshId); } catch (error) { this.#fail(refreshId, error); throw error; } }
		return { ...structuredClone(job), cancellationRequested: controller !== undefined || job.state === "cancelled" };
	}
	async stampMissingDefinition(identityFor: (job: { mode: string; stores: string[] }, version: string) => string, version: string): Promise<void> {
		for (const job of this.#jobs.values()) {
			const identity = identityFor(job, version);
			if (job.definition && job.definition !== identity) throw new DatastoreError("INDEX_CORRUPT");
			job.definition = identity;
		}
		await this.persist();
	}
	#finish(refreshId: string): void { this.#settlePersist.get(refreshId)?.resolve(); this.#persisted.delete(refreshId); this.#settlePersist.delete(refreshId); if (!this.#controllers.has(refreshId)) this.#explicitCancel.delete(refreshId); }
	#fail(refreshId: string, error: unknown): void { this.#settlePersist.get(refreshId)?.reject(error); this.#persisted.delete(refreshId); this.#settlePersist.delete(refreshId); this.#explicitCancel.delete(refreshId); }
	async persisted(refreshId: string): Promise<void> {
		await this.ensureLoaded();
		const existing = this.#persisted.get(refreshId);
		if (existing) return existing;
		const job = this.#jobs.get(refreshId);
		if (!job) throw new DatastoreError("INVALID_NOTE_REF");
		if (["succeeded", "failed", "cancelled"].includes(job.state) && !this.#controllers.has(refreshId)) return this.#persistTail.then(() => undefined);
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
		this.#settlePersist.set(refreshId, { resolve, reject });
		const again = this.#jobs.get(refreshId);
		if (again && ["succeeded", "failed", "cancelled"].includes(again.state) && !this.#controllers.has(refreshId)) { this.#settlePersist.delete(refreshId); return this.#persistTail.then(() => undefined); }
		this.#persisted.set(refreshId, promise);
		return promise;
	}
	async settled(): Promise<void> { await this.#tail.catch(() => undefined); await this.#persistTail.catch(() => undefined); }
	shutdown(): void { this.#hostClosing = true; this.#closed = true; for (const controller of this.#controllers.values()) controller.abort(new DatastoreError("CANCELLED")); }
}
