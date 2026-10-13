import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const files = readdirSync("tests").filter(name => name.endsWith(".test.ts") && name !== "package.test.ts");
const result = spawnSync(process.execPath, ["--test", ...files.map(name => `tests/${name}`)], { stdio: "inherit", timeout: 300_000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
