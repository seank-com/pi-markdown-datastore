import { inspectTerminalHistory, initializeTerminalHistory } from "./maintenance-migration.ts";

export async function main(args: string[]): Promise<void> {
 let stateRoot: string | undefined, initialize = false;
 for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--state-root" && stateRoot === undefined && args[i + 1]) stateRoot = args[++i];
  else if (args[i] === "--initialize-terminal-history" && !initialize) initialize = true;
  else throw new Error("Usage: maintenance-migration-main.js --state-root ABSOLUTE_PATH [--initialize-terminal-history]");
 }
 if (!stateRoot) throw new Error("--state-root is required; inspection is the default, initialization requires an explicit flag");
 const report = await (initialize ? initializeTerminalHistory(stateRoot) : inspectTerminalHistory(stateRoot));
 process.stdout.write(JSON.stringify(report) + "\n");
}
if (import.meta.main) {
 void main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.code ? error.code + ": " : ""}${error.message}\n`);
  process.exitCode = 1;
 });
}
