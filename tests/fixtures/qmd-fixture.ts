import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

export async function createQmdFixture(project: string): Promise<string> {
  const root = join(project, "synthetic-qmd");
  await mkdir(root);
  const source = await readFile(new URL("./qmd-sdk.ts", import.meta.url), "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 } }).outputText;
  await writeFile(join(root, "sdk.mjs"), compiled);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@tobilu/qmd", version: "2.8.3", type: "module", exports: { ".": { import: "./sdk.mjs" } } }));
  return root;
}
