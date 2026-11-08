"use client";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import type { CompSpec } from "./sceneSpec";

const DOT: Record<CompSpec["key"], string> = {
  pv: "bg-comp-pv",
  inverter: "bg-comp-pv",
  battery: "bg-comp-battery",
  wallbox: "bg-comp-wallbox",
  heatpump: "bg-comp-heatpump",
};

/** Label card above a component: name, size with unit, the engine's first reason. */
export function Tooltip({ spec, position }: { spec: CompSpec; position: THREE.Vector3 }) {
  return (
    <Html position={position} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
      <div
        aria-hidden
        className="hidden w-max max-w-64 -translate-y-[calc(50%+10px)] rounded-md border border-border bg-surface-1/95 px-3 py-2 text-ink shadow-[0_12px_32px_rgba(16,17,20,0.10)] backdrop-blur-sm sm:block"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[spec.key]}`} />
          {spec.title}
          {spec.size && <span className="font-mono text-[13px] font-medium tabular-nums text-ink-body">{spec.size}</span>}
        </div>
        {spec.reason && <p className="mt-1 text-[13px] leading-[18px] text-ink-body">{spec.reason}</p>}
        {spec.note && <p className="mt-1 text-[13px] leading-[18px] text-warning-text">{spec.note}</p>}
      </div>
    </Html>
  );
}

const SHORT: Record<CompSpec["key"], string> = {
  pv: "Solar", inverter: "Inverter", battery: "Battery", wallbox: "Wallbox", heatpump: "Heat pump",
};

/** Always-on label for a projector: name and size, big enough to read from the back of the room. */
/** Which side of its point a label sits on, so neighbours (battery and wallbox on the garage) never overlap. */
export type LabelSide = "left" | "right" | "above";
const SIDE: Record<LabelSide, string> = {
  left: "-translate-x-[calc(50%+14px)] -translate-y-1/2",
  right: "translate-x-[calc(50%+14px)] -translate-y-1/2",
  above: "-translate-y-[calc(100%+6px)]",
};

const EDGE = 8; // px kept free at the stage edge
const GAP = 14;
const P = new THREE.Vector3();

/**
 * Where a label goes on screen so it stays inside the stage: a side label that would run past the edge goes above
 * its anchor instead, and an "above" label slides inwards. Pure, for tests. `x` is the anchor's screen x, `w` the label width, `W` the stage width.
 */
export function placeLabel(side: LabelSide, x: number, w: number, W: number): { side: LabelSide; shift: number } {
  // a side label that does not fit goes above its anchor (flipping sides would land on the neighbour's label)
  const fits = side === "right" ? x + GAP + w <= W - EDGE : side === "left" ? x - GAP - w >= EDGE : true;
  if (!fits) side = "above";
  if (side === "above") {
    const left = x - w / 2;
    const shift = left < EDGE ? EDGE - left : left + w > W - EDGE ? W - EDGE - (left + w) : 0;
    return { side, shift: Math.round(shift) };
  }
  return { side, shift: 0 };
}

export function Label({ spec, position, side = "above" }: { spec: CompSpec; position: THREE.Vector3; side?: LabelSide }) {
  const size = spec.size?.split(" (")[0];
  const anchor = useRef<THREE.Group>(null);
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ side: LabelSide; shift: number }>({ side, shift: 0 });
  // keep the label inside the stage (narrow stages: two houses side by side on /reality)
  useFrame(({ camera, size: s }) => {
    const g = anchor.current;
    const el = box.current;
    if (!g || !el) return;
    g.getWorldPosition(P).project(camera);
    const next = placeLabel(side, ((P.x + 1) / 2) * s.width, el.offsetWidth, s.width);
    if (next.side !== at.side || Math.abs(next.shift - at.shift) > 2) setAt(next);
  });
  return (
    <group ref={anchor} position={position}>
      <Html center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
        <div
          ref={box}
          aria-hidden
          // margins move by half (drei centres the wrapper): ×2. A side label moved above rises clear of its neighbours.
          style={{ marginLeft: at.shift * 2, marginTop: at.side !== side ? -44 : 0 }}
          className={`flex w-max ${SIDE[at.side]} items-center gap-1.5 rounded-full border border-border bg-surface-1/95 py-1 pl-2 pr-3 text-ink shadow-[0_8px_24px_rgba(16,17,20,0.12)] backdrop-blur-sm @[640px]:gap-2 @[640px]:py-1.5 @[640px]:pl-2.5 @[640px]:pr-3.5`}
        >
          <span aria-hidden className={`size-2 shrink-0 rounded-full @[640px]:size-2.5 ${DOT[spec.key]}`} />
          <span className="text-[13px] font-semibold @[640px]:text-base">{SHORT[spec.key]}</span>
          {size && <span className="font-mono text-[13px] font-medium tabular-nums text-ink-body @[640px]:text-base">{size}</span>}
        </div>
      </Html>
    </group>
  );
}
