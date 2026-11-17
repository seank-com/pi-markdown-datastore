import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { DatastoreError } from "./errors.ts";
import { acquireIndexOwnership, legacyOwnerState, type IndexOwnership } from "./index-ownership.ts";
import { MaintenanceCoordinator } from "./maintenance-coordinator.ts";

export interface HistoricalLedger {
 path: string;
 sha256: string;
 jobs: number;
 unfinishedJobs: number;
 owner: "clear" | "live" | "uncertain";
}
export interface TerminalHistoryReport {
 stateRoot: string;
 stableLedgerExists: boolean;
 owner: "clear" | "live" | "uncertain";
 histories: HistoricalLedger[];
 jobs: number;
 unfinishedJobs: number;
 eligible: boolean;
 initialized: boolean;
}

async function protectedDirectory(path: string): Promise<void> {
 const info = await lstat(path);
 if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new DatastoreError("INDEX_CORRUPT");
}
async function stateDirectory(input: string): Promise<string> {
 if (!isAbsolute(input)) throw new DatastoreError("CONFIG_INVALID");
 const root = resolve(input);
 if (await realpath(root) !== root) throw new DatastoreError("CONFIG_INVALID");
 await protectedDirectory(root);
 return root;
}
async function stableExists(root: string): Promise<boolean> {
 try { await lstat(join(root, "jobs.json")); return true; }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function histories(root: string): Promise<HistoricalLedger[]> {
 const result: HistoricalLedger[] = [];
 for (const name of (await readdir(root)).sort()) {
  if (!/^qmd-public-.+-[0-9a-f]{16}$/.test(name)) continue;
  const directory = join(root, name), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) continue;
  const file = join(directory, "jobs.json");
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  await protectedDirectory(directory);
  // The same protected application-ledger format checked by the coordinator.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 256 * 1024) throw new DatastoreError("INDEX_CORRUPT");
  const bytes = await readFile(file);
  let raw: any;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch { throw new DatastoreError("INDEX_CORRUPT"); }
  const names = new Set<string>();
  if (Array.isArray(raw?.jobs)) for (const job of raw.jobs) if (Array.isArray(job?.stores)) for (const store of job.stores) if (typeof store === "string") names.add(store);
  // Reuse the actual schema validator on a protected copy. Loading a real
  // historical ledger would normalize/persist it, so never load the original.
  const temp = await mkdtemp(join(tmpdir(), "datastore-ledger-validation-"));
  const copy = join(temp, "jobs.json"), probe = new MaintenanceCoordinator(copy, () => names);
  try {
   await writeFile(copy, bytes, { flag: "wx", mode: 0o600 });
   await probe.ensureLoaded();
  } finally { probe.shutdown(); await probe.settled(); await rm(temp, { recursive: true, force: true }); }
  const unfinishedJobs = raw.jobs.filter((job: any) => job.state === "queued" || job.state === "running").length;
  result.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex"), jobs: raw.jobs.length, unfinishedJobs, owner: await legacyOwnerState(directory) });
 }
 return result;
}

/** Read-only with respect to live state; validation copies are disposable. */
export async function inspectTerminalHistory(input: string): Promise<TerminalHistoryReport> {
 const root = await stateDirectory(input);
 const [exists, owner, history] = await Promise.all([stableExists(root), legacyOwnerState(root), histories(root)]);
 const jobs = history.reduce((sum, item) => sum + item.jobs, 0);
 const unfinishedJobs = history.reduce((sum, item) => sum + item.unfinishedJobs, 0);
 return { stateRoot: root, stableLedgerExists: exists, owner, histories: history, jobs, unfinishedJobs, eligible: !exists && owner === "clear" && unfinishedJobs === 0 && history.every(item => item.owner === "clear"), initialized: false };
}

/** Explicit operator transition, not automatic adoption of an unproven origin. */
export async function initializeTerminalHistory(input: string): Promise<TerminalHistoryReport> {
 const plan = await inspectTerminalHistory(input);
 // Existing state is never replaced, repaired or merged by this operation.
 if (plan.stableLedgerExists) return plan;
 if (!plan.eligible) throw new DatastoreError("STORE_UNAVAILABLE");
 const leases: IndexOwnership[] = [];
 const temp = join(plan.stateRoot, `jobs.json.initializing-${randomBytes(8).toString("hex")}`);
 try {
  leases.push(await acquireIndexOwnership(plan.stateRoot));
  if (await stableExists(plan.stateRoot)) throw new DatastoreError("STORE_UNAVAILABLE");
  for (const item of plan.histories) leases.push(await acquireIndexOwnership(dirname(item.path)));
  const current = await histories(plan.stateRoot);
  // Changes after inspection require another explicit inspection, not a guessed
  // history or a queue silently abandoned during publication.
  if (current.length !== plan.histories.length || current.some((item, i) => item.path !== plan.histories[i].path || item.sha256 !== plan.histories[i].sha256 || item.unfinishedJobs !== 0)) throw new DatastoreError("STORE_UNAVAILABLE");
  await writeFile(temp, JSON.stringify({ version: 1, jobs: [] }), { flag: "wx", mode: 0o600 });
  const file = await open(temp, "r");
  try { await file.sync(); } finally { await file.close(); }
  if (await stableExists(plan.stateRoot)) throw new DatastoreError("STORE_UNAVAILABLE");
  await rename(temp, join(plan.stateRoot, "jobs.json"));
  return { ...plan, stableLedgerExists: true, eligible: false, initialized: true };
 } finally {
  await rm(temp, { force: true });
  for (const lease of leases.reverse()) await lease.release();
 }
}
