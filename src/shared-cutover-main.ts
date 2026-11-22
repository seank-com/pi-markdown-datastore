import { prepareSharedCutover } from "./shared-cutover.ts";

const [catalog, output, stateRoot, ...extra] = process.argv.slice(2);
if (!catalog || !output || !stateRoot || extra.length) {
	process.stderr.write("usage: shared-cutover-main <absolute-catalog> <new-bundle-directory> <new-state-root>\n");
	process.exit(2);
}
try {
	await prepareSharedCutover(catalog, output, stateRoot);
	process.stdout.write("Prepared a terminal-history bundle only; no configuration activated.\n");
} catch (error) {
	process.stderr.write(`Shared cutover refused: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
