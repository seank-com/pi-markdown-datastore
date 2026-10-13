import { semanticRefreshBatch } from "./semantic-refresh.ts";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { SearchMode } from "./contract.ts";
import type { MarkdownDatastoreConfig, StoreConfig } from "./config.ts";
import { HARD_MAX_CANDIDATES } from "./config.ts";
import { validateRelativeNotePath, walkSafeNoteMetadata } from "./containment.ts";
import { abortError, DatastoreError, throwIfAborted } from "./errors.ts";
import { QmdWorkerClient, type QmdWorkerProgress, type QmdWorkerRequest } from "./qmd-worker-client.ts";

const TESTED_QMD_VERSIONS = new Set(["2.8.3"]);
const MAX_REFRESH_DOCUMENTS = 100_000;
const MAX_REFRESH_SOURCE_BYTES = 512 * 1024 * 1024;
const TERMINAL_JOB_LIMIT = 20;

export interface QmdBinding { packageRoot: string; packageRootDev: number; packageRootIno: number; packageJsonPath: string; packageDev: number; packageIno: number; version: string; sdkPath: string; sdkDev: number; sdkIno: number; sdkUrl: string }
export interface QmdManifestEntry { revision: string; mtime: string; size: number; backendPath: string }
export interface QmdManifest { version: 2; backendVersion: string; configFingerprint: string; generatedAt: string; semanticAt?: string; pendingEmbeddings: number; hasVectorIndex: boolean; stores: Record<string, Record<string, QmdManifestEntry>> }
export interface QmdCandidate { path: string; backendRank: number; score?: number; indexedRevision?: string }
export interface QmdSearchResult { candidates: QmdCandidate[]; rejectedCandidates: number; manifest: QmdManifest; generation: string; requestedMode: SearchMode; effectiveMode: SearchMode; embeddingActive: boolean; queueMs: number; operationMs: number; workerId?: number }
export type QmdRefreshPhase = "queued" | "scanning" | "updating" | "embedding" | "validating" | "promoting" | "succeeded" | "failed" | "cancelled";
export interface QmdRefreshJob {
	version: 1; refreshId: string; key: string; mode: "lexical" | "semantic"; stores: string[]; ownership: "startup-reconciliation" | "explicit-maintenance";
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; phase: QmdRefreshPhase;
	createdAt: string; updatedAt: string; completedAt?: string; generation?: string; errorCode?: string;
	progress: { documentsCompleted: number; documentsTotal?: number; sourceBytesCompleted: number; sourceBytesTotal?: number; chunksCompleted: number; chunksTotal?: number; embeddingBytesCompleted: number; embeddingBytesTotal?: number; errors: number };
}

function inside(root: string, target: string): boolean {
	const rel = relative(root, target); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function compareVersion(version: string, floor: string): boolean {
	const a = version.split(".").map(Number); const b = floor.split(".").map(Number);
	if (a.length !== 3 || b.length !== 3 || [...a, ...b].some(Number.isNaN)) return false;
	for (let index = 0; index < 3; index += 1) { if (a[index] > b[index]) return true; if (a[index] < b[index]) return false; }
	return true;
}
async function executableFromPath(name: string, environment: NodeJS.ProcessEnv): Promise<string> {
	if (isAbsolute(name)) return realpath(name);
	if (name.includes("/")) throw new DatastoreError("BACKEND_MISSING");
	for (const entry of (environment.PATH ?? "").split(":")) {
		if (!entry) continue;
		const candidate = resolve(entry, name);
		try { const info = await stat(candidate); if (info.isFile() && (info.mode & 0o111) !== 0) return realpath(candidate); } catch {}
	}
	throw new DatastoreError("BACKEND_MISSING");
}

export async function discoverQmdBinding(config: MarkdownDatastoreConfig, environment = process.env): Promise<QmdBinding> {
	const requestedRoot = config.qmd.installation.packageRoot;
	let packageRoot: string | undefined = requestedRoot ? await realpath(requestedRoot).catch(() => undefined) : undefined;
	if (requestedRoot && !packageRoot) throw new DatastoreError("BACKEND_MISSING");
	if (!packageRoot) {
		let current = dirname(await executableFromPath(config.qmd.installation.executable!, environment));
		for (;;) {
			try { const info = await stat(join(current, "package.json")); if (info.isFile()) { packageRoot = current; break; } } catch {}
			const parent = dirname(current); if (parent === current) break; current = parent;
		}
	}
	if (!packageRoot) throw new DatastoreError("BACKEND_MISSING");
	const packageJsonPath = join(packageRoot, "package.json");
	const packageRootInfo = await lstat(packageRoot).catch(() => { throw new DatastoreError("BACKEND_MISSING"); }); const packageInfo = await lstat(packageJsonPath).catch(() => { throw new DatastoreError("BACKEND_MISSING"); });
	if (!packageRootInfo.isDirectory() || packageRootInfo.isSymbolicLink() || !packageInfo.isFile() || packageInfo.isSymbolicLink()) throw new DatastoreError("BACKEND_MISSING");
	let manifest: any;
	try { manifest = JSON.parse(await readFile(packageJsonPath, "utf8")); } catch { throw new DatastoreError("BACKEND_OUTPUT_INVALID"); }
	if (manifest.name !== "@tobilu/qmd" || typeof manifest.version !== "string" || !TESTED_QMD_VERSIONS.has(manifest.version) || !compareVersion(manifest.version, config.qmd.minimumVersion)) throw new DatastoreError("BACKEND_VERSION_UNSUPPORTED");
	const exportPath = manifest.exports?.["."]?.import;
	if (typeof exportPath !== "string") throw new DatastoreError("BACKEND_OUTPUT_INVALID");
	const sdkPath = await realpath(resolve(packageRoot, exportPath)).catch(() => { throw new DatastoreError("BACKEND_OUTPUT_INVALID"); });
	if (!inside(packageRoot, sdkPath)) throw new DatastoreError("BACKEND_OUTPUT_INVALID"); const sdkInfo = await lstat(sdkPath); if (!sdkInfo.isFile() || sdkInfo.isSymbolicLink()) throw new DatastoreError("BACKEND_OUTPUT_INVALID");
	return { packageRoot, packageRootDev: packageRootInfo.dev, packageRootIno: packageRootInfo.ino, packageJsonPath, packageDev: packageInfo.dev, packageIno: packageInfo.ino, version: manifest.version, sdkPath, sdkDev: sdkInfo.dev, sdkIno: sdkInfo.ino, sdkUrl: pathToFileURL(sdkPath).href };
}

async function protectedDir(path: string): Promise<void> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try { info = await lstat(path); } catch (error: any) { if (error?.code !== "ENOENT") throw new DatastoreError("INDEX_CORRUPT"); await mkdir(path, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if(error.code !== "EEXIST") throw error; }); info = await lstat(path); }
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new DatastoreError("INDEX_CORRUPT");
}
async function atomicJson(path: string, value: unknown): Promise<void> {
	const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
	await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
	const handle = await open(temp, constants.O_RDONLY); await handle.sync(); await handle.close();
	await rename(temp, path); await chmod(path, 0o600);
	const directory = await open(dirname(path), constants.O_RDONLY); await directory.sync(); await directory.close();
}

export class QmdAdapter {
 readonly config: MarkdownDatastoreConfig; readonly binding: QmdBinding; readonly root: string; readonly configFingerprint: string;
 #reader: QmdWorkerClient; #writer: QmdWorkerClient;
 #readTail: Promise<void> = Promise.resolve(); #refreshTail: Promise<void> = Promise.resolve();
 #rebuilding = false; #needsRebuild = false; #embeddingActive = false; #closed = false; #lifecycle = new AbortController(); #refreshActive = false;
 #runningJobs = new Set<Promise<void>>(); #jobs = new Map<string, QmdRefreshJob>(); #jobControllers = new Map<string, AbortController>();
 #jobsLoaded = false; #jobsLoad?: Promise<void>; #persistTail: Promise<void> = Promise.resolve();
 #runtimeLexicalCurrent = new Set<string>(); #startup?: Promise<Record<string, unknown>>;
 #metadataLoaded = false; #manifest?: QmdManifest; #generation = `gen-${randomBytes(16).toString("hex")}`;
 #semanticStores = new Set<StoreConfig>(); #semanticBatchError?: string;
 #semanticBatch = semanticRefreshBatch(async () => {
  if (!this.#semanticStores.size || this.#manifest?.pendingEmbeddings === 0) return true;
  const stores = [...this.#semanticStores]; this.#semanticStores.clear();
  await this.startSemanticRefresh(stores); return true;
 }, error => { this.#semanticBatchError = error ? "BACKEND_FAILED" : undefined; });
 constructor(config: MarkdownDatastoreConfig, binding: QmdBinding) {
  this.config = config; this.binding = binding;
  this.configFingerprint = createHash("sha256").update(JSON.stringify([...config.stores.values()])).digest("hex");
  // A new release/config gets independent derived state; older indexes are never migrated in place.
  this.root = join(config.stateRoot, `qmd-public-${binding.version}-${this.configFingerprint.slice(0,16)}`);
  this.#reader = new QmdWorkerClient(config.defaults.operationTimeoutMs);
  this.#writer = new QmdWorkerClient(35 * 60_000);
 }
 private operationSignal(signal?: AbortSignal): AbortSignal { return AbortSignal.any([this.#lifecycle.signal, ...(signal ? [signal] : [])]); }
 private async validateBinding(): Promise<void> {
  const binding = await discoverQmdBinding(this.config);
  if (binding.sdkPath !== this.binding.sdkPath || binding.sdkIno !== this.binding.sdkIno || binding.packageIno !== this.binding.packageIno || binding.packageRootIno !== this.binding.packageRootIno) throw new DatastoreError("BACKEND_VERSION_UNSUPPORTED");
  for (const store of this.config.stores.values()) { const info = await stat(store.root); if (!info.isDirectory() || info.dev !== store.rootDev || info.ino !== store.rootIno) throw new DatastoreError("STORE_UNAVAILABLE"); }
 }
 private async prepare(): Promise<void> {
  await protectedDir(this.config.stateRoot); await protectedDir(this.root);
  if (!this.#metadataLoaded) {
   const path=join(this.root,"reconciliation.json");
   try { const info=await lstat(path); if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || info.uid!==process.getuid?.() || (info.mode & 0o077)!==0 || info.size>65536)throw new DatastoreError("INDEX_CORRUPT");
    const saved=JSON.parse(await readFile(path,"utf8"));
    if(saved.version!==2 || saved.backendVersion!==this.binding.version || saved.configFingerprint!==this.configFingerprint || typeof saved.generatedAt!=="string" || !Number.isSafeInteger(saved.pendingEmbeddings) || saved.pendingEmbeddings<0 || typeof saved.hasVectorIndex!=="boolean" || (saved.semanticAt!==undefined && typeof saved.semanticAt!=="string") || !/^gen-[0-9a-f]{32}$/.test(saved.generation))throw new DatastoreError("INDEX_CORRUPT");
    this.#manifest=saved;this.#generation=saved.generation;
   }catch(error:any){if(error?.code!=="ENOENT")throw new DatastoreError("INDEX_CORRUPT");}
   this.#metadataLoaded=true;
  }
  await protectedDir(join(this.root,"backend"));
  for (const name of await readdir(join(this.root,"backend"))) { const info = await lstat(join(this.root,"backend",name)).catch((error: NodeJS.ErrnoException) => { if(error.code === "ENOENT")return undefined;throw error; }); if(!info)continue; if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new DatastoreError("INDEX_CORRUPT"); }
 }
 private request(operation: string, extra: Record<string, unknown> = {}): QmdWorkerRequest {
  return { version: 2, sdkUrl: this.binding.sdkUrl, dbPath: join(this.root,"backend","index.sqlite"), config: { collections: Object.fromEntries([...this.config.stores.values()].map(s => [s.search.qmdCollection,{path:s.root,pattern:s.include[0],ignore:s.exclude,includeByDefault:false}])) }, operation, ...extra };
 }
 private waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal); return new Promise((resolve,reject) => { const abort = () => reject(abortError(signal)); signal.addEventListener("abort",abort,{once:true}); operation.then(value => { signal.removeEventListener("abort",abort);resolve(value); },error => {signal.removeEventListener("abort",abort);reject(error);}); });
 }
 activity() { const jobs = this.jobStatuses(); const active = this.#refreshActive; const queued = jobs.some(j=>j.state === "queued"); return { state: active ? "running" as const : queued ? "queued" as const : "idle" as const, active, queued, embeddingActive: this.#embeddingActive, jobs, semanticBatchError: this.#semanticBatchError }; }
 async refresh(stores: StoreConfig[], semantic: boolean, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const receipt = await this.startRefreshJob(stores, semantic ? "semantic" : "lexical", "explicit-maintenance");
  const activeSignal = this.operationSignal(signal);
  while (true) { throwIfAborted(activeSignal); const job = this.#jobs.get(String(receipt.refreshId))!; if (job.state === "succeeded") return {generation:job.generation}; if (job.state === "failed" || job.state === "cancelled") throw new DatastoreError(job.errorCode as any ?? "BACKEND_FAILED"); await this.waitFor(new Promise(r=>setTimeout(r,10)),activeSignal); }
 }
 private async refreshInner(stores: StoreConfig[], semantic: boolean, signal?: AbortSignal, report?: (phase: QmdRefreshPhase, progress?: QmdWorkerProgress) => void): Promise<Record<string, unknown>> {
  const activeSignal = this.operationSignal(signal); throwIfAborted(activeSignal);
  // Admission is synchronous before any await: already admitted semantic reads drain first.
  this.#refreshActive = true; this.#embeddingActive = semantic; this.#rebuilding = this.#needsRebuild; for (const store of stores) this.#runtimeLexicalCurrent.delete(store.name); report?.("scanning");
  try {
   await this.#readTail; throwIfAborted(activeSignal); await this.validateBinding(); await this.prepare();
   if(this.#needsRebuild) {
    await Promise.all([this.#reader.shutdown(),this.#writer.shutdown()]);
    await rename(join(this.root,"backend"),join(this.root,`quarantine-${randomBytes(8).toString("hex")}`));
    await protectedDir(join(this.root,"backend"));
    this.#reader=new QmdWorkerClient(this.config.defaults.operationTimeoutMs);
    this.#writer=new QmdWorkerClient(35*60_000);
    this.#needsRebuild=false; this.#rebuilding=false; this.#runtimeLexicalCurrent.clear(); stores=[...this.config.stores.values()];
   }
   report?.("scanning"); let count=0,bytes=0;
   for (const store of stores) await walkSafeNoteMetadata(store, note => { if (++count > MAX_REFRESH_DOCUMENTS || (bytes+=note.size) > MAX_REFRESH_SOURCE_BYTES) throw new DatastoreError("RESULT_LIMIT_EXCEEDED"); },activeSignal);
   report?.("updating");
   let raw; try { raw = await this.#writer.request(this.request("refresh",{collections:stores.map(s=>s.search.qmdCollection),semantic}), {signal:activeSignal,progressive:true,onProgress:p=>report?.(p.phase,p)}); } catch(error) { if (error instanceof DatastoreError && error.code === "BACKEND_FAILED") this.#needsRebuild=true; throw error; }
   if (raw.update.skipped > 0 || raw.embed?.errors || semantic && raw.status.needsEmbedding > 0) throw new DatastoreError("BACKEND_FAILED",{retryable:true,partial:true});
   this.#manifest = { version:2, backendVersion:this.binding.version,configFingerprint:this.configFingerprint,generatedAt:new Date().toISOString(),pendingEmbeddings:raw.status.needsEmbedding,hasVectorIndex:raw.status.hasVectorIndex,stores:{} };
   if (raw.status.needsEmbedding === 0 && raw.status.hasVectorIndex) this.#manifest.semanticAt=this.#manifest.generatedAt;
   this.#generation=`gen-${randomBytes(16).toString("hex")}`;
   await atomicJson(join(this.root,"reconciliation.json"),{...this.#manifest,generation:this.#generation});
   return {generation:this.#generation,...raw};
  } catch(error) { this.#manifest=undefined; this.#runtimeLexicalCurrent.clear(); throw error; }
  finally { this.#refreshActive=false; this.#embeddingActive=false; this.#rebuilding=false; }
 }
	private jobStatuses(): QmdRefreshJob[] { return [...this.#jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((job) => structuredClone(job)); }
	private async ensureJobs(): Promise<void> {
		if (this.#jobsLoaded) return; if (this.#jobsLoad) return this.#jobsLoad;
		this.#jobsLoad = this.loadJobs(); try { await this.#jobsLoad; } finally { this.#jobsLoad = undefined; }
	}
	private async loadJobs(): Promise<void> {
		await protectedDir(this.config.stateRoot); await protectedDir(this.root); const path = join(this.root, "jobs.json"); let raw: any;
		try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 256 * 1024) throw new DatastoreError("INDEX_CORRUPT"); raw = JSON.parse(await readFile(path, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") { if (error instanceof DatastoreError) throw error; throw new DatastoreError("INDEX_CORRUPT"); } raw = { version: 1, jobs: [] }; }
		if (raw?.version !== 1 || !Array.isArray(raw.jobs) || raw.jobs.length > TERMINAL_JOB_LIMIT || Object.keys(raw).some((key) => !["version", "jobs"].includes(key))) throw new DatastoreError("INDEX_CORRUPT");
		for (const value of raw.jobs) {
			const jobRaw = value as Record<string, unknown>; const allowed = ["version", "refreshId", "key", "mode", "stores", "ownership", "state", "phase", "createdAt", "updatedAt", "completedAt", "generation", "errorCode", "progress"];
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(jobRaw).some((key) => !allowed.includes(key)) || jobRaw.version !== 1 || typeof jobRaw.refreshId !== "string" || !/^[0-9a-f]{32}$/.test(jobRaw.refreshId) || !["lexical", "semantic"].includes(String(jobRaw.mode)) || !Array.isArray(jobRaw.stores) || jobRaw.stores.some((name) => typeof name !== "string" || !this.config.stores.has(name)) || new Set(jobRaw.stores).size !== jobRaw.stores.length || !["startup-reconciliation", "explicit-maintenance"].includes(String(jobRaw.ownership)) || !["queued", "running", "succeeded", "failed", "cancelled"].includes(String(jobRaw.state)) || !["queued", "scanning", "updating", "embedding", "validating", "promoting", "succeeded", "failed", "cancelled"].includes(String(jobRaw.phase)) || typeof jobRaw.createdAt !== "string" || typeof jobRaw.updatedAt !== "string" || (jobRaw.completedAt !== undefined && typeof jobRaw.completedAt !== "string") || (jobRaw.generation !== undefined && (typeof jobRaw.generation !== "string" || !/^gen-[0-9a-f]{32}$/.test(jobRaw.generation))) || (jobRaw.errorCode !== undefined && (typeof jobRaw.errorCode !== "string" || !/^[A-Z_]{3,64}$/.test(jobRaw.errorCode))) || !jobRaw.progress || typeof jobRaw.progress !== "object" || Array.isArray(jobRaw.progress)) throw new DatastoreError("INDEX_CORRUPT");
			const stores = [...jobRaw.stores as string[]].sort(); const mode = jobRaw.mode as "lexical" | "semantic"; const key = `${mode}:${stores.join(",")}`; if (jobRaw.key !== key) throw new DatastoreError("INDEX_CORRUPT"); const progressRaw = jobRaw.progress as Record<string, unknown>; const progressAllowed = ["documentsCompleted", "documentsTotal", "sourceBytesCompleted", "sourceBytesTotal", "chunksCompleted", "chunksTotal", "embeddingBytesCompleted", "embeddingBytesTotal", "errors"]; if (Object.keys(progressRaw).some((field) => !progressAllowed.includes(field))) throw new DatastoreError("INDEX_CORRUPT"); for (const field of progressAllowed) if (progressRaw[field] !== undefined && (!Number.isSafeInteger(progressRaw[field]) || (progressRaw[field] as number) < 0)) throw new DatastoreError("INDEX_CORRUPT");
			const job: QmdRefreshJob = { version: 1, refreshId: jobRaw.refreshId, key, mode, stores, ownership: jobRaw.ownership as QmdRefreshJob["ownership"], state: jobRaw.state as QmdRefreshJob["state"], phase: jobRaw.phase as QmdRefreshPhase, createdAt: jobRaw.createdAt, updatedAt: jobRaw.updatedAt, completedAt: jobRaw.completedAt as string | undefined, generation: jobRaw.generation as string | undefined, errorCode: jobRaw.errorCode as string | undefined, progress: { documentsCompleted: Number(progressRaw.documentsCompleted ?? 0), documentsTotal: progressRaw.documentsTotal as number | undefined, sourceBytesCompleted: Number(progressRaw.sourceBytesCompleted ?? 0), sourceBytesTotal: progressRaw.sourceBytesTotal as number | undefined, chunksCompleted: Number(progressRaw.chunksCompleted ?? 0), chunksTotal: progressRaw.chunksTotal as number | undefined, embeddingBytesCompleted: Number(progressRaw.embeddingBytesCompleted ?? 0), embeddingBytesTotal: progressRaw.embeddingBytesTotal as number | undefined, errors: Number(progressRaw.errors ?? 0) } };
			if (job.state === "queued" || job.state === "running") { job.state = "queued"; job.phase = "queued"; delete job.errorCode; delete job.completedAt; job.updatedAt = new Date().toISOString(); } this.#jobs.set(job.refreshId, job);
		}
		this.#jobsLoaded = true; await this.persistJobs();
	}
	private pruneJobs(reserve = 0): void { const terminal = this.jobStatuses().filter((job) => !["queued", "running"].includes(job.state)).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)); while (this.#jobs.size + reserve > TERMINAL_JOB_LIMIT && terminal.length) this.#jobs.delete(terminal.shift()!.refreshId); if (this.#jobs.size + reserve > TERMINAL_JOB_LIMIT) throw new DatastoreError("RESULT_LIMIT_EXCEEDED"); }
	private persistJobs(): Promise<void> {
		this.pruneJobs(); const snapshot = { version: 1, jobs: this.jobStatuses() }; const write = this.#persistTail.catch(() => undefined).then(() => atomicJson(join(this.root, "jobs.json"), snapshot)); this.#persistTail = write; return write;
	}
	async startLexicalRefresh(stores: StoreConfig[], ownership: QmdRefreshJob["ownership"] = "explicit-maintenance"): Promise<Record<string, unknown>> { return this.startRefreshJob(stores, "lexical", ownership); }
	async startSemanticRefresh(stores: StoreConfig[]): Promise<Record<string, unknown>> { return this.startRefreshJob(stores, "semantic", "explicit-maintenance"); }
	startupReconcile(stores: StoreConfig[]): Promise<Record<string, unknown>> {
		if (this.#startup) return this.#startup;
		const operation = (async () => { if (this.#closed) throw new DatastoreError("CANCELLED"); await this.ensureJobs(); if (this.#closed) throw new DatastoreError("CANCELLED"); for (const job of this.#jobs.values()) if (job.state === "queued") this.launchJob(job); if (this.#closed) throw new DatastoreError("CANCELLED"); return this.startRefreshJob(stores, "lexical", "startup-reconciliation"); })(); this.#startup = operation; return operation;
	}
	isLexicallyCurrent(store: string): boolean { return this.#runtimeLexicalCurrent.has(store); }
	private async startRefreshJob(stores: StoreConfig[], mode: "lexical" | "semantic", ownership: QmdRefreshJob["ownership"]): Promise<Record<string, unknown>> {
		if (this.#closed) throw new DatastoreError("CANCELLED"); await this.validateBinding(); if (this.#closed) throw new DatastoreError("CANCELLED"); await this.ensureJobs(); if (this.#closed) throw new DatastoreError("CANCELLED"); const ordered = [...stores].sort((a, b) => a.name.localeCompare(b.name)); const key = `${mode}:${ordered.map((store) => store.name).join(",")}`;
		const existing = [...this.#jobs.values()].find((job) => job.key === key && (job.state === "queued" || job.state === "running")); if (existing) { this.launchJob(existing); return { ...structuredClone(existing), coalesced: true }; } this.pruneJobs(1);
		for (const store of ordered) this.#runtimeLexicalCurrent.delete(store.name);
		const now = new Date().toISOString(); const job: QmdRefreshJob = { version: 1, refreshId: randomBytes(16).toString("hex"), key, mode, stores: ordered.map((store) => store.name), ownership, state: "queued", phase: "queued", createdAt: now, updatedAt: now, progress: { documentsCompleted: 0, sourceBytesCompleted: 0, chunksCompleted: 0, embeddingBytesCompleted: 0, errors: 0 } }; this.#jobs.set(job.refreshId, job); try { await this.persistJobs(); } catch (error) { this.#jobs.delete(job.refreshId); throw error; }
		this.launchJob(job); return { ...structuredClone(job), coalesced: false };
	}
	private launchJob(job: QmdRefreshJob): void {
		if (this.#closed || this.#jobControllers.has(job.refreshId) || job.state !== "queued") return; const stores = job.stores.map((name) => this.config.stores.get(name)!); const controller = new AbortController(); this.#jobControllers.set(job.refreshId, controller); const task = this.runRefreshJob(job, stores, controller); this.#runningJobs.add(task); void task.finally(() => this.#runningJobs.delete(task)).catch(() => undefined);
	}
	private async runRefreshJob(job: QmdRefreshJob, stores: StoreConfig[], controller: AbortController): Promise<void> {
		const previous = this.#refreshTail; const signal = AbortSignal.any([controller.signal, this.#lifecycle.signal]); let lastPersisted = 0;
		const report = (phase: QmdRefreshPhase, update?: QmdWorkerProgress | { documentsCompleted: number; sourceBytesCompleted: number; documentsTotal?: number; sourceBytesTotal?: number }): void => {
			if (["succeeded", "failed", "cancelled"].includes(job.phase)) return; const changedPhase = job.phase !== phase; job.phase = phase; job.state = phase === "queued" ? "queued" : "running"; job.updatedAt = new Date().toISOString();
			if (update && "documentsCompleted" in update) { job.progress.documentsCompleted = update.documentsCompleted; job.progress.sourceBytesCompleted = update.sourceBytesCompleted; if (update.documentsTotal !== undefined) job.progress.documentsTotal = update.documentsTotal; if (update.sourceBytesTotal !== undefined) job.progress.sourceBytesTotal = update.sourceBytesTotal; }
			else if (update) { const workerProgress = update as QmdWorkerProgress; if (workerProgress.documents) { job.progress.documentsCompleted = workerProgress.documents.completed; job.progress.documentsTotal = workerProgress.documents.total; } if (workerProgress.chunks) { job.progress.chunksCompleted = workerProgress.chunks.completed; job.progress.chunksTotal = workerProgress.chunks.total; } if (workerProgress.bytes) { job.progress.embeddingBytesCompleted = workerProgress.bytes.completed; job.progress.embeddingBytesTotal = workerProgress.bytes.total; } if (workerProgress.errors !== undefined) job.progress.errors = workerProgress.errors; }
			if (changedPhase || Date.now() - lastPersisted >= 1000) { lastPersisted = Date.now(); void this.persistJobs().catch(() => controller.abort(new DatastoreError("INDEX_CORRUPT"))); }
		};
		const operation = (async () => { await previous.catch(() => undefined); throwIfAborted(signal); return this.refreshInner(stores, job.mode === "semantic", signal, report); })(); this.#refreshTail = operation.then(() => undefined, () => undefined);
		try { const result = await operation; job.state = "succeeded"; job.phase = "succeeded"; job.generation = String(result.generation); for (const store of stores) if (![...this.#jobs.values()].some(other => other.refreshId !== job.refreshId && ["queued", "running"].includes(other.state) && other.stores.includes(store.name))) this.#runtimeLexicalCurrent.add(store.name); if (job.mode === "lexical") { for (const store of stores) this.#semanticStores.add(store); this.#semanticBatch.schedule(); } }
		catch (error) { const safe = error instanceof DatastoreError ? error : new DatastoreError("BACKEND_FAILED"); if (this.#lifecycle.signal.aborted && !controller.signal.aborted) { job.state = "queued"; job.phase = "queued"; delete job.errorCode; delete job.completedAt; } else { job.state = safe.code === "CANCELLED" ? "cancelled" : "failed"; job.phase = job.state; job.errorCode = safe.code; job.completedAt = new Date().toISOString(); } }
		finally { job.updatedAt = new Date().toISOString(); if (["succeeded", "failed", "cancelled"].includes(job.state)) job.completedAt ??= job.updatedAt; this.#jobControllers.delete(job.refreshId); await this.persistJobs().catch(() => { job.state="failed"; job.phase="failed"; job.errorCode="INDEX_CORRUPT"; }); }
	}
	async cancelRefresh(refreshId: string): Promise<Record<string, unknown>> {
		await this.ensureJobs(); const job = this.#jobs.get(refreshId); if (!job) throw new DatastoreError("INVALID_NOTE_REF"); const controller = this.#jobControllers.get(refreshId); if (controller) controller.abort(new DatastoreError("CANCELLED")); if (job.state === "queued") { job.state = "cancelled"; job.phase = "cancelled"; job.errorCode = "CANCELLED"; job.updatedAt = new Date().toISOString(); job.completedAt = job.updatedAt; await this.persistJobs(); } return { ...structuredClone(job), cancellationRequested: controller !== undefined || job.state === "cancelled" };
	}
	async cancelSemanticRefresh(refreshId: string): Promise<Record<string, unknown>> { return this.cancelRefresh(refreshId); }

 async search(store: StoreConfig, query: string, mode: SearchMode, limit: number, minScore: number | undefined, signal?: AbortSignal): Promise<QmdSearchResult> {
  const activeSignal=this.operationSignal(signal); throwIfAborted(activeSignal);
  const admitted=Date.now();
  // Reserve the search before yielding. Maintenance cannot overtake an admitted semantic read.
  if(this.#rebuilding)throw new DatastoreError("STALE_INDEX");
  const unavailable=this.#embeddingActive;
  if(this.#refreshActive && !unavailable && mode!=="lexical")throw new DatastoreError("STALE_INDEX");
  if (unavailable && mode === "semantic") throw new DatastoreError("SEMANTIC_UNAVAILABLE",{retryable:true,requestedMode:mode});
  const effectiveMode=unavailable && mode === "hybrid" ? "lexical" : mode;
  const previous=this.#readTail;
  const operation=(async()=>{
   await this.waitFor(previous,activeSignal); throwIfAborted(activeSignal); await this.validateBinding(); await this.prepare();
   const started=Date.now();
   const raw=await this.#reader.request(this.request("search",{collection:store.search.qmdCollection,query,mode:effectiveMode,limit:Math.min(HARD_MAX_CANDIDATES,limit),minScore}),{signal:activeSignal});
   const state=raw.status;
   if (effectiveMode !== "lexical" && (state.needsEmbedding > 0 || !state.hasVectorIndex)) throw new DatastoreError("STALE_INDEX");
   const manifest:QmdManifest={version:2,backendVersion:this.binding.version,configFingerprint:this.configFingerprint,generatedAt:this.#manifest?.generatedAt ?? "",pendingEmbeddings:state.needsEmbedding,hasVectorIndex:state.hasVectorIndex,stores:{[store.name]:{}}};
   if (state.needsEmbedding===0 && state.hasVectorIndex) manifest.semanticAt=this.#manifest?.semanticAt ?? "backend-complete";
   let rejectedCandidates=0;
   const candidates=raw.results.flatMap((entry:any,index:number):QmdCandidate[]=>{
    let path:string;try{path=decodeQmdUri(entry.uri,store.search.qmdCollection);}catch{rejectedCandidates++;return [];}
    manifest.stores[store.name][path]={revision:entry.indexedRevision,mtime:"",size:0,backendPath:path};
    return [{path,backendRank:index+1,score:entry.score,indexedRevision:entry.indexedRevision}];
   });
   return {candidates,rejectedCandidates,manifest,generation:this.#generation,requestedMode:mode,effectiveMode,embeddingActive:unavailable,queueMs:started-admitted,operationMs:Date.now()-started,workerId:this.#reader.processId};
  })();
  this.#readTail=operation.then(()=>undefined,()=>undefined); return operation;
 }
 async status(signal?: AbortSignal): Promise<Record<string,unknown>> {
  await this.ensureJobs(); const activeSignal=this.operationSignal(signal); throwIfAborted(activeSignal);
  if (this.#refreshActive) return {state:"degraded",reasonCode:this.#embeddingActive ? "SEMANTIC_UNAVAILABLE" : "STALE_INDEX",version:this.binding.version,refresh:this.activity(),stores:{}};
  const previous=this.#readTail;const operation=(async()=>{await this.waitFor(previous,activeSignal);await this.validateBinding();await this.prepare();const raw=await this.#reader.request(this.request("status"),{signal:activeSignal});return {state:"ready",version:this.binding.version,generatedAt:this.#manifest?.generatedAt,semanticAt:raw.status.needsEmbedding===0 && raw.status.hasVectorIndex ? this.#manifest?.semanticAt : undefined,documentCount:raw.status.totalDocuments,pendingEmbeddings:raw.status.needsEmbedding,hasVectorIndex:raw.status.hasVectorIndex,refresh:this.activity(),stores:Object.fromEntries([...this.config.stores.values()].map(s=>[s.name,{documentCount:raw.collections.find((c:any)=>c.name===s.search.qmdCollection)?.active_count,runtimeLexicalCurrent:this.isLexicallyCurrent(s.name)}]))};})();this.#readTail=operation.then(()=>undefined,()=>undefined);return operation;
 }
 async shutdown(): Promise<void> { if(this.#closed)return;this.#closed=true;this.#lifecycle.abort(new DatastoreError("CANCELLED"));await this.#semanticBatch.close();await Promise.allSettled([...this.#runningJobs,this.#refreshTail,this.#readTail,...(this.#startup?[this.#startup]:[])]);await Promise.all([this.#reader.shutdown(),this.#writer.shutdown()]);await this.#persistTail.catch(()=>undefined); }
}
export function decodeQmdUri(uri: unknown, expectedCollection: string): string {
 if(typeof uri!=="string" || uri.includes("?") || uri.includes("#") || !uri.startsWith(`qmd://${expectedCollection}/`))throw new DatastoreError("BACKEND_OUTPUT_INVALID");
 // qmd 2.8.3 public paths are literal, not percent-encoded URLs.
 return validateRelativeNotePath(uri.slice(`qmd://${expectedCollection}/`.length));
}
