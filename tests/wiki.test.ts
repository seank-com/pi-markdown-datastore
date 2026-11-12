import assert from "node:assert/strict";
import test from "node:test";
import { extractWikilinks, tagIdentity } from "../src/wiki.ts";

test("raw wikilinks ignore escapes, code and ordinary markdown", () => {
	const text = [
		"---",
		"tags: [Travel, travel]",
		"---",
		"See [[folder/page|Friendly name]] and ![[images/map.png|512]].",
		"Not a link: \\[[literal]] or `[[coded]]`.",
		"```",
		"[[inside-fence]]",
		"```",
		"[page](notes/page.md)",
		"[[page#Heading]]",
	].join("\n");
	const refs = extractWikilinks(text, 3);
	assert.deepEqual(refs.map((ref) => ref.raw), ["[[folder/page|Friendly name]]", "![[images/map.png|512]]", "[[page#Heading]]"]);
	assert.equal(refs[0].suffix, "Friendly name");
	assert.equal(refs[1].kind, "embed");
	assert.equal(refs[1].suffix, "512");
	assert.equal(refs[2].fragment, "Heading");
	assert.equal(tagIdentity("Travel"), tagIdentity("#travel"));
});
