import { rmSync } from "node:fs";
// dist is generated exclusively by this package. A clean build cannot ship stale modules.
rmSync(new URL("../dist/", import.meta.url), { recursive: true, force: true });
