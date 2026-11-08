import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { Noto_Serif } from "next/font/google";
import { LiveCall } from "@/components/planner/live-call";

export const metadata: Metadata = { title: "Live call · Reonic AI Designer" };

/** The caller's own words (design brief: Noto Serif only for people's words). */
const quote = Noto_Serif({ subsets: ["latin"], weight: ["400"], display: "swap" });

/** Planner-side big screen for an incoming voice-agent call: the house builds itself while the caller talks. */
export default function LivePage() {
  return (
    <Suspense fallback={<main className="flex-1" />}>
      <Live />
    </Suspense>
  );
}

async function Live() {
  await connection(); // time-based UI (call clock): render per request
  return <LiveCall quoteFont={quote.className} />;
}
