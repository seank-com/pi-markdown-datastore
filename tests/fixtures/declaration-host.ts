import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeDeclarationHost(directory: string, settings: {
	socketPath: string;
	stateRoot: string;
	defaults: unknown;
	qmd: unknown;
	reader: { maxFileBytes: number; defaultMode: "lexical" | "semantic" | "hybrid" };
	stores: Array<{ root: string; include?: string[]; exclude?: string[] }>;
}): Promise<string> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const path = join(directory, "host.json");
	await writeFile(path, JSON.stringify({
		schemaVersion: 1, socketPath: settings.socketPath, stateRoot: settings.stateRoot,
		defaults: settings.defaults, qmd: settings.qmd, reader: settings.reader,
	}), { mode: 0o600 });
	const registrations = Object.fromEntries(settings.stores.map(store => [store.root, { include: store.include ?? ["**/*.md"], exclude: store.exclude ?? [] }]));
	await writeFile(join(directory, "registrations.json"), JSON.stringify({ schemaVersion: 1, registrations }), { mode: 0o600 });
	return path;
}
