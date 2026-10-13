import { randomBytes } from "node:crypto";
import type { NoteRef, ReadView } from "./contract.ts";
import { DatastoreError } from "./errors.ts";

export interface ContinuationDescriptor {
	kind: "read"; note: NoteRef; revision: string; cursor: number; view: ReadView;
	includeFrontmatter: boolean; headingPath?: string[]; occurrence?: number; sectionHandle?: string;
	excludeSections: string[]; includeSemanticRelated: boolean; maxBytes: number; maxLines: number; createdAt: number; expiresAt: number;
}
export interface SectionHandleDescriptor {
	kind: "section"; note: NoteRef; revision: string; headingPath: string[]; occurrence: number;
	startLine: number; endLine: number; createdAt: number; expiresAt: number;
}
type Descriptor = ContinuationDescriptor | SectionHandleDescriptor;
type NewDescriptor = Descriptor extends infer D ? D extends Descriptor ? Omit<D, "createdAt" | "expiresAt"> : never : never;

export class ContinuationRegistry {
	readonly maximum: number;
	readonly ttlMs: number;
	#items = new Map<string, Descriptor>();
	constructor(maximum = 256, ttlMs = 15 * 60_000) { this.maximum = maximum; this.ttlMs = ttlMs; }
	create(descriptor: NewDescriptor, now = Date.now()): string {
		this.prune(now);
		while (this.#items.size >= this.maximum) this.#items.delete(this.#items.keys().next().value!);
		const id = randomBytes(16).toString("hex");
		this.#items.set(id, { ...descriptor, createdAt: now, expiresAt: now + this.ttlMs } as Descriptor);
		return id;
	}
	getRead(id: string, now = Date.now()): ContinuationDescriptor {
		if (!/^[0-9a-f]{32}$/.test(id)) throw new DatastoreError("EXPIRED_CONTINUATION");
		const descriptor = this.#items.get(id);
		if (!descriptor || descriptor.expiresAt <= now || descriptor.kind !== "read") { this.#items.delete(id); throw new DatastoreError("EXPIRED_CONTINUATION"); }
		this.#items.delete(id); this.#items.set(id, descriptor);
		return descriptor;
	}
	getSection(id: string, now = Date.now()): SectionHandleDescriptor {
		if (!/^[0-9a-f]{32}$/.test(id)) throw new DatastoreError("AMBIGUOUS_SECTION");
		const descriptor = this.#items.get(id);
		if (!descriptor || descriptor.expiresAt <= now || descriptor.kind !== "section") { this.#items.delete(id); throw new DatastoreError("AMBIGUOUS_SECTION"); }
		this.#items.delete(id); this.#items.set(id, descriptor);
		return descriptor;
	}
	prune(now = Date.now()): void { for (const [id, descriptor] of this.#items) if (descriptor.expiresAt <= now) this.#items.delete(id); }
	clear(): void { this.#items.clear(); }
	get size(): number { return this.#items.size; }
}
