import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { RealityView } from "@/components/reality/reality-view";
import { engine } from "@/lib/engine";
import { demoProjects, heldOutIds } from "@/lib/heldout";

export const metadata: Metadata = { title: "Reality check · Reonic AI Designer" };

export default function RealityPage() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10" aria-busy="true" />}>
      <Reality />
    </Suspense>
  );
}

async function Reality() {
  await connection();
  const [evalRes, ids, demos] = await Promise.all([engine.eval(), heldOutIds(), demoProjects()]);
  return <RealityView evalRes={evalRes} ids={ids} demos={demos} />;
}
