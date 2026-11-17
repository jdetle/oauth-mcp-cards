import { Suspense } from "react";
import { Lobby } from "../src/ui/Lobby.tsx";

export default function Page() {
  return (
    <Suspense fallback={<main className="wrap">Loading…</main>}>
      <Lobby />
    </Suspense>
  );
}
