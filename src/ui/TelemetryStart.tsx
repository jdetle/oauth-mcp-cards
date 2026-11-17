"use client";
import { useEffect } from "react";
import { startTelemetry } from "./telemetry.ts";

/** Starts s10, Sentry and the analytics tags once the page is interactive. */
export function TelemetryStart() {
  useEffect(() => startTelemetry(), []);
  return null;
}
