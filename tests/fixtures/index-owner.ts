import { acquireIndexOwnership, type IndexOwnership } from "../../src/index-ownership.ts";
let ownership: IndexOwnership | undefined;
process.on("message", async (message: { action: string }) => {
	if (message.action === "acquire") {
		try {
			ownership = await acquireIndexOwnership(process.argv[2]!);
			process.send?.({ state: "owned", directory: ownership.directory, nonce: ownership.nonce, ownerName: ownership.ownerName });
		} catch (error) { process.send?.({ state: "refused", code: (error as { code?: string }).code }); }
	}
	if (message.action === "release") {
		await ownership?.release();
		process.exit(0);
	}
});
process.send?.({ state: "armed" });
