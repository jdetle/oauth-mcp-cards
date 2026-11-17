// What this table's game calls its four seats. The engine has four seat slots (client,
// application, idp, mcp); each game in the series names them (User, Orchestrator, …).
// One table per page, so the names are set once per render by the table and read anywhere below it.
import { ROLE_NAMES, type Role } from "../game/types.ts";

let names: Record<Role, string> = { ...ROLE_NAMES };

export function setSeats(next: Record<Role, string> | undefined) {
  names = next ? { ...ROLE_NAMES, ...next } : { ...ROLE_NAMES };
}

export const seat = (role: Role): string => names[role] ?? ROLE_NAMES[role];
