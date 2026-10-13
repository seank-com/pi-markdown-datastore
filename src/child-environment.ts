import { DatastoreError } from "./errors.ts";

const OPTIONAL_NAMES = ["USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "XDG_CACHE_HOME", "QMD_EMBED_MODEL", "QMD_LLAMA_GPU", "QMD_FORCE_CPU", "QMD_EMBED_PARALLELISM"] as const;

/**
 * Backend children receive only local execution and cache-location variables.
 * Provider, Telegram, credential, Node injection, and dynamic-loader variables
 * are deliberately not inherited.
 */
export function datastoreChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (!source.HOME) throw new DatastoreError("BACKEND_MISSING");
	const environment: NodeJS.ProcessEnv = {
		HOME: source.HOME,
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
	};
	for (const name of OPTIONAL_NAMES) {
		const value = source[name];
		if (value) environment[name] = value;
	}
	return environment;
}
