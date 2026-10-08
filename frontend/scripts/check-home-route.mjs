import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const registry = await readFile(new URL("../src/screens/registry.ts", import.meta.url), "utf8");

assert.doesNotMatch(
  registry,
  /"DASH-001":\s*HomeBuilderScreen/,
  "DASH-001 must use the standard ScreenPage dashboard",
);
assert.match(
  registry,
  /"DASH-002":\s*HomeBuilderScreen/,
  "DASH-002 must retain the configurable organization dashboard",
);

console.log("HOME ROUTE PASS");
