import { startSharedHost } from "./shared-host.ts";

const [flag, path, ...extra] = process.argv.slice(2);
if (!path || extra.length || (flag !== "--catalog" && flag !== "--host-config")) {
	process.stderr.write("shared datastore service requires --catalog or --host-config and a path\n");
	process.exit(2);
}
const host = await startSharedHost(path, { declarations: flag === "--host-config" });
const stop = () => { void host.close().finally(() => process.exit(0)); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdout.write(`${host.generation}\n`);
