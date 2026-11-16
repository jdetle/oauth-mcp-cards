import data from "./scenarios.generated.json";
import type { Scenario } from "./scenario.ts";

export const SCENARIOS = data as unknown as Scenario[];
