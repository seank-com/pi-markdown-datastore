import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatastoreError } from "./errors.ts";

const MEMBER = /^(owner|worker)-([1-9][0-9]*)-([0-9a-f]{32})$/;

export interface IndexOwnership {
	directory: string;
	ownerName: string;
	nonce: string;
	release(): Promise<void>;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		// An inaccessible or otherwise unverified process is not proven dead.
		return true;
	}
}

export async function legacyOwnerState(root: string): Promise<"clear" | "live" | "uncertain"> {
	const directory = join(root, "owner");
	const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
	if (!info) return "clear";
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return "uncertain";
	const names = await readdir(directory).catch(() => undefined);
	if (!names) return "uncertain";
	for (const name of names) {
		const member = MEMBER.exec(name);
		if (!member || !Number.isSafeInteger(Number(member[2]))) return "uncertain";
		const file = await lstat(join(directory, name)).catch(() => undefined);
		if (!file) continue;
		if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) return "uncertain";
		if (alive(Number(member[2]))) return "live";
	}
	return "clear";
}

/** Acquire application ownership outside qmd's opaque backend directory. */
export async function acquireIndexOwnership(root: string): Promise<IndexOwnership> {
	const directory = join(root, "owner");
	const nonce = randomBytes(16).toString("hex");
	const ownerName = `owner-${process.pid}-${nonce}`;
	const candidate = await mkdtemp(join(root, "owner-candidate-"));
	try {
		// Publish a NONEMPTY directory atomically. A competing owner can never
		// mistake the interval between mkdir and writing metadata for a dead owner.
		await writeFile(join(candidate, ownerName), "", { flag: "wx", mode: 0o600 });
		const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (info) {
			if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new DatastoreError("INDEX_CORRUPT");
			const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
			for (const name of names) {
				const member = MEMBER.exec(name);
				if (!member || !Number.isSafeInteger(Number(member[2]))) throw new DatastoreError("INDEX_CORRUPT");
				const file = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return undefined;
					throw error;
				});
				if (!file) continue;
				if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new DatastoreError("INDEX_CORRUPT");
				if (alive(Number(member[2]))) throw new DatastoreError("STORE_UNAVAILABLE");
			}
			for (const name of names) {
				// Names contain the old generation nonce. A stale observer cannot
				// unlink the new owner's differently named record after replacement.
				await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		}
		try { await rename(candidate, directory); }
		catch (error) {
			if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new DatastoreError("STORE_UNAVAILABLE");
			throw error;
		}
		let released = false;
		return {
			directory, ownerName, nonce,
			release: async () => {
				if (released) return;
				released = true;
				const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return [];
					throw error;
				});
				for (const name of names) if (MEMBER.test(name) && name.endsWith(`-${nonce}`)) {
					await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
				}
				await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
					if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
				});
			},
		};
	} finally { await rm(candidate, { recursive: true, force: true }); }
}
