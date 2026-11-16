"use client";
import { href } from "../../src/ui/paths.ts";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Table } from "../../src/ui/Table.tsx";

function Play() {
  const room = useSearchParams().get("room") ?? "";
  if (!/^[a-z]+-[a-z]+(-\d{1,3})?$/.test(room)) {
    return (
      <main className="wrap">
        <p>No such room. <a href={href("/")}>Back to the lobby</a></p>
      </main>
    );
  }
  return <Table room={room} />;
}

export default function Page() {
  return (
    <Suspense fallback={<main className="wrap">Loading…</main>}>
      <Play />
    </Suspense>
  );
}
