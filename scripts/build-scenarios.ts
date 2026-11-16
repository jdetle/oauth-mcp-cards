// Compiles scenarios/*.json into one validated bundle the PartyKit server imports.
// Run automatically by `bun run dev`, `build`, and `test`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateScenario } from "../src/game/scenario.ts";

const dir = join(import.meta.dir, "..", "scenarios");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const ids = new Set<string>();
const all = files.map((f) => {
  const s = validateScenario(JSON.parse(readFileSync(join(dir, f), "utf8")), f);
  if (ids.has(s.id)) throw new Error(`${f}: duplicate id "${s.id}"`);
  ids.add(s.id);
  return s;
});
all.sort((a, b) => a.order - b.order);
writeFileSync(join(import.meta.dir, "..", "src", "game", "scenarios.generated.json"), JSON.stringify(all, null, 1) + "\n");
console.log(`scenarios: ${all.length} compiled (${all.map((s) => s.phase[0]).join("")})`);
