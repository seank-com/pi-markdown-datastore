import { startSharedHost } from "./shared-host.ts";

const catalogFlag = process.argv.indexOf("--catalog");
const catalog = catalogFlag >= 0 ? process.argv[catalogFlag + 1] : undefined;
if (!catalog) {
	process.stderr.write("shared datastore service requires --catalog\n");
	process.exit(2);
}
const host = await startSharedHost(catalog);
const stop = () => { void host.close().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdout.write(`${host.generation}\n`);
