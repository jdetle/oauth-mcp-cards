# OAuth for MCP card game

- Bun for everything (`bun install`, `bun run`, `bun test`, `bunx`). Next.js 16 front end (static export) + PartyKit multiplayer.
- `bun run dev` = PartyKit (:1999) + Next (:3000). Needs `.env` with `INTERNAL_SECRET`.
- Game rules live in `src/game/` and must stay transport-agnostic and JSON-serialisable (PartyKit persists `Game.state`).
- `src/game/validate.ts` is pure: every accept/reject is judged there. Add a test in `tests/validate.test.ts` for any new rule.
- Scenarios are data in `scenarios/*.json`, compiled by `bun run scenarios` into `src/game/scenarios.generated.json` (committed, imported by the PartyKit bundle).
- Crypto must be portable (Bun, browser, workerd): use `src/game/crypto.ts` (`@noble/*`), never `node:crypto`.
- UI code may import `src/game/types.ts` and `reference.ts`, not `engine.ts`/`validate.ts`.
- Before finishing: `bun run typecheck`, `bun run test:unit`; for server changes also `bun run test` (spawns partykit dev).
