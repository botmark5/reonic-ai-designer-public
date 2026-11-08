import { Suspense } from "react";
import { connection } from "next/server";
import { PlannerApp } from "@/components/planner/planner-app";
import { DEFAULT_INSTALLER, engine } from "@/lib/engine";
import { getStore, NEW_HOME, NEW_LOCKS, seedIfEmpty } from "@/lib/store";

export default function Page({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<PlannerSkeleton />}>
      <Planner searchParams={searchParams} />
    </Suspense>
  );
}

async function Planner({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await connection();
  const { d } = await searchParams;
  const store = getStore();
  await seedIfEmpty(store); // fresh database: example homes, once
  let designs = await store.listDesigns();
  let initial = (typeof d === "string" && designs.find((x) => x.id === d)) || designs[0];
  if (!initial) {
    initial = await store.createDesign({
      call_id: null, source: "planner", status: "draft", customer_name: "Example home", address: null, explanation: null,
      home: NEW_HOME, locks: NEW_LOCKS, design: null,
    });
    designs = [initial];
  }
  if (!initial.design || initial.design.served?.source === "offline") {
    const design = await engine.design({ installer: DEFAULT_INSTALLER, home: initial.home, locks: initial.locks });
    initial = (await store.updateDesign(initial.id, { design })) ?? { ...initial, design };
  }
  return <PlannerApp designs={designs} initial={initial} />;
}

function PlannerSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:grid-cols-[264px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)_336px]" aria-busy="true">
      <div className="hidden h-[520px] animate-pulse rounded-md bg-surface-2/60 lg:block" />
      <div className="flex flex-col gap-4">
        <div className="h-20 animate-pulse rounded-md bg-surface-2/60" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-64 animate-pulse rounded-md bg-surface-2/60" />)}
        </div>
      </div>
      <div className="hidden h-[520px] animate-pulse rounded-md bg-surface-2/60 xl:block" />
    </div>
  );
}
