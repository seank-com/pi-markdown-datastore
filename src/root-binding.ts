import { lstat, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DatastoreError } from "./errors.ts";
import type { StoreConfig } from "./config.ts";

interface SharedObservation { committed: boolean; active: number; rejected: boolean; discarded: boolean; discard: Array<() => void> }
const sharedObservations = new WeakMap<StoreConfig, SharedObservation>();
export function provisionSharedStore(store: StoreConfig, discard: () => void): void {
	sharedObservations.set(store, { committed: false, active: 0, rejected: false, discarded: false, discard: [discard] });
}
function releaseRejected(state: SharedObservation): void {
	if (!state.rejected || state.committed || state.active || state.discarded) return;
	state.discarded = true; for (const discard of state.discard) discard(); state.discard.length = 0;
}
export function onSharedStoreDiscard(store: StoreConfig, discard: () => void): void {
	const state = sharedObservations.get(store);
	if (state?.discarded) discard(); else if (state && !state.committed) state.discard.push(discard);
}
export function commitSharedStore(store: StoreConfig): void {
	const state = sharedObservations.get(store); if (state && !state.discarded) { state.committed = true; state.discard.length = 0; }
}
export function rejectSharedStore(store: StoreConfig): void {
	const state = sharedObservations.get(store); if (state) { state.rejected = true; releaseRejected(state); }
}
/** Successful source/policy use commits the exact object observed, never a later map entry. */
export function observeSource(store: StoreConfig): (success: boolean) => void {
	const state = sharedObservations.get(store);
	if (!state) return () => undefined;
	if (state.discarded) throw new DatastoreError("STORE_UNAVAILABLE");
	state.active++; let finished = false;
	return success => {
		if (finished) return; finished = true;
		if (success) commitSharedStore(store); else state.rejected = true;
		state.active--; releaseRejected(state);
	};
}

/** Filesystem liveness is not configuration authority. Permission and alias errors stay structural. */
export function isRootUnavailable(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error &&
		["ENOENT", "EIO", "ETIMEDOUT", "ESTALE", "ENODEV", "ENXIO", "ENETDOWN", "ENETUNREACH", "EHOSTDOWN", "EHOSTUNREACH"].includes(String(error.code));
}

/** An absent root has no identity. Capture only after validating all existing ancestry. */
export async function inspectConfiguredRoot(input: string, aliasError: "CONFIG_INVALID" | "SYMLINK_REJECTED" = "CONFIG_INVALID"): Promise<{ root: string; rootDev: number; rootIno: number } | undefined> {
	const root = resolve(input);
	let current: string = sep;
	try {
		for (const part of root.split(sep).filter(Boolean)) {
			current = join(current, part);
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new DatastoreError(aliasError);
			if (!info.isDirectory()) throw new DatastoreError("CONFIG_INVALID");
		}
		const info = await lstat(root);
		if (await realpath(root) !== root || info.isSymbolicLink()) throw new DatastoreError(aliasError);
		if (!info.isDirectory()) throw new DatastoreError("CONFIG_INVALID");
		return { root, rootDev: info.dev, rootIno: info.ino };
	} catch (error) {
		if (isRootUnavailable(error)) return undefined;
		if (error instanceof DatastoreError) throw error;
		throw new DatastoreError("CONFIG_INVALID");
	}
}
