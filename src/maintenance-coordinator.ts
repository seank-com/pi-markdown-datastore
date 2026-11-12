import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatastoreError, throwIfAborted } from "./errors.ts";
import type { QmdRefreshJob, QmdRefreshPhase } from "./qmd-adapter.ts";

const TERMINAL_JOB_LIMIT = 20;
type Mode = "lexical" | "semantic" | "metadata";
export type MaintenanceRunner = (job: QmdRefreshJob, signal: AbortSignal, report: (phase: QmdRefreshPhase) => void) => Promise<{ generation?: string } | void>;

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
export class MaintenanceCoordinator {
	#jobs = new Map<string, QmdRefreshJob>();
	#controllers = new Map<string, AbortController>();
	#runners = new Map<Mode, MaintenanceRunner>();
	#loaded = false;
	#loading?: Promise<void>;
	#tail: Promise<void> = Promise.resolve();
	#persistTail: Promise<void> = Promise.resolve();
	#closed = false;
	#hostClosing = false;
	readonly jobsPath: string;
	readonly knownStores: () => ReadonlySet<string>;
	constructor(jobsPath: string, knownStores: () => ReadonlySet<string>) { this.jobsPath = jobsPath; this.knownStores = knownStores; }
	register(mode: Mode, runner: MaintenanceRunner): void { this.#runners.set(mode, runner); }
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
			const job = value as QmdRefreshJob;
			if (!job || job.version !== 1 || !/^[0-9a-f]{32}$/.test(job.refreshId) || !["lexical", "semantic", "metadata"].includes(job.mode) || !Array.isArray(job.stores) || job.stores.some((name) => !this.knownStores().has(name))) throw new DatastoreError("INDEX_CORRUPT");
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
	async enqueue(mode: Mode, stores: string[], ownership: QmdRefreshJob["ownership"]): Promise<Record<string, unknown>> {
		if (this.#closed) throw new DatastoreError("CANCELLED");
		await this.ensureLoaded();
		const ordered = [...stores].sort();
		const key = `${mode}:${ordered.join(",")}`;
		const existing = [...this.#jobs.values()].find((job) => job.key === key && (job.state === "queued" || job.state === "running"));
		if (existing) { this.launch(existing); return { ...structuredClone(existing), coalesced: true }; }
		const now = new Date().toISOString();
		const job: QmdRefreshJob = { version: 1, refreshId: randomBytes(16).toString("hex"), key, mode, stores: ordered, ownership, state: "queued", phase: "queued", createdAt: now, updatedAt: now, progress: { documentsCompleted: 0, sourceBytesCompleted: 0, chunksCompleted: 0, embeddingBytesCompleted: 0, errors: 0 } };
		this.#jobs.set(job.refreshId, job);
		try { await this.persist(); } catch (error) { this.#jobs.delete(job.refreshId); throw error; }
		this.launch(job);
		return { ...structuredClone(job), coalesced: false };
	}
	relaunchQueued(): void { for (const job of this.#jobs.values()) if (job.state === "queued") this.launch(job); }
	private launch(job: QmdRefreshJob): void {
		if (this.#closed || this.#controllers.has(job.refreshId) || job.state !== "queued") return;
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
			const result = await runner(job, controller.signal, (phase) => { job.phase = phase; job.state = "running"; job.updatedAt = new Date().toISOString(); });
			job.state = "succeeded"; job.phase = "succeeded"; if (result && "generation" in result && result.generation) job.generation = result.generation;
		})().catch((error: unknown) => {
			if (this.#hostClosing) { job.state = "queued"; job.phase = "queued"; delete job.errorCode; delete job.completedAt; return; }
			const safe = error instanceof DatastoreError ? error : new DatastoreError("BACKEND_FAILED");
			job.state = safe.code === "CANCELLED" ? "cancelled" : "failed";
			job.phase = job.state; job.errorCode = safe.code;
		}).finally(() => {
			job.updatedAt = new Date().toISOString();
			if (["succeeded", "failed", "cancelled"].includes(job.state)) job.completedAt ??= job.updatedAt;
			this.#controllers.delete(job.refreshId);
			void this.persist();
		});
		this.#tail = operation.then(() => undefined, () => undefined);
	}
	async cancel(refreshId: string): Promise<Record<string, unknown>> {
		await this.ensureLoaded();
		const job = this.#jobs.get(refreshId);
		if (!job) throw new DatastoreError("INVALID_NOTE_REF");
		const controller = this.#controllers.get(refreshId);
		controller?.abort(new DatastoreError("CANCELLED"));
		if (job.state === "queued") { job.state = "cancelled"; job.phase = "cancelled"; job.errorCode = "CANCELLED"; job.updatedAt = new Date().toISOString(); job.completedAt = job.updatedAt; await this.persist(); }
		return { ...structuredClone(job), cancellationRequested: controller !== undefined || job.state === "cancelled" };
	}
	async settled(): Promise<void> { await this.#tail.catch(() => undefined); await this.#persistTail.catch(() => undefined); }
	shutdown(): void { this.#hostClosing = true; this.#closed = true; for (const controller of this.#controllers.values()) controller.abort(new DatastoreError("CANCELLED")); }
}
