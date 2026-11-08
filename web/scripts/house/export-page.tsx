"use client";
// Template: web/scripts/house/export-stills.mjs copies this to src/app/house3d-export/page.tsx for one run and removes
// it afterwards. Not a product page. The script hands the design in via window.__H3D and the "h3d" event.
import { useSyncExternalStore } from "react";
import { HouseStage, type HouseStageProps } from "@/components/house3d";
import type { DesignResponse, Home } from "@/lib/types";

type Shot = { design: DesignResponse; home: Home; mode?: "planner" | "homeowner"; clean?: boolean } & Pick<
  HouseStageProps, "location" | "view" | "zones" | "sunMap" | "reveal" | "labels" | "controls" | "timeOfDay"
>;
declare global {
  interface Window { __H3D?: Shot }
}

const subscribe = (cb: () => void) => {
  window.addEventListener("h3d", cb);
  return () => window.removeEventListener("h3d", cb);
};

export default function House3DExport() {
  const shot = useSyncExternalStore(subscribe, () => window.__H3D ?? null, () => null);
  if (!shot) return null;
  return (
    <main data-h3d-export data-clean={shot.clean ? "" : undefined} className="fixed inset-0 z-[100] overflow-hidden bg-surface-0">
      <style>{`
        html, body { overflow: hidden; }
        [data-h3d-export] figure { height: 100dvh; }
        [data-h3d-export] [data-h3d-stage] { aspect-ratio: auto; height: 100%; }
        [data-h3d-export] > div { height: 100dvh; }
        [data-h3d-export][data-clean] [data-h3d-ui] { display: none; }
        nextjs-portal { display: none; }
      `}</style>
      <HouseStage
        design={shot.design}
        home={shot.home}
        mode={shot.mode ?? "homeowner"}
        location={shot.location}
        view={shot.view ?? "outside"}
        zones={shot.zones}
        sunMap={shot.sunMap}
        reveal={shot.reveal}
        labels={shot.labels}
        controls={shot.controls}
        timeOfDay={shot.timeOfDay}
        flyIn={false}
        className="rounded-none border-0"
      />
    </main>
  );
}
