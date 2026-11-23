import { startSharedHost } from "./shared-host.ts";

const [flag, path, ...extra] = process.argv.slice(2);
if (!path || extra.length || flag !== "--host-config") {
	process.stderr.write("shared datastore service requires --host-config and a path\n");
	process.exit(2);
}
const host = await startSharedHost(path);
const stop = () => { void host.close().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdout.write(`${host.generation}\n`);
