import { copyFileSync } from "node:fs";
copyFileSync(new URL("../src/qmd-worker.mjs", import.meta.url), new URL("../dist/qmd-worker.mjs", import.meta.url));
