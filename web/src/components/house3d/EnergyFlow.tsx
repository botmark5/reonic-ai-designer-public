"use client";
import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { FlowNodeId, LiveFlow } from "./energyDay";
import { SETTLE, stepSpring, type SpringState } from "./spring";

/** Every flow the scene can show; each stays mounted and fades in/out as the day changes. */
const FLOW_PATHS: Record<string, FlowNodeId[]> = {
  "panels-house": ["panels", "inverter", "house"],
  "panels-battery": ["panels", "inverter", "battery"],
  "panels-car": ["panels", "inverter", "wallbox", "car"],
  "panels-grid": ["panels", "inverter", "grid"],
  "battery-house": ["battery", "inverter", "house"],
  "grid-house": ["grid", "house"],
  "house-heatpump": ["house", "heatpump"],
};

type LineHandle = { material: { dashOffset: number; opacity: number; linewidth: number }; visible: boolean } | null;

/** Arc from a to b, lifted and pushed south (towards the viewer) so it clears walls. */
function arc(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3[], first: boolean) {
  const d = a.distanceTo(b);
  const mid = a.clone().lerp(b, 0.5);
  mid.y += Math.min(2.2, d * 0.2);
  mid.z += Math.min(1.4, d * 0.12);
  const pts = new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(Math.max(8, Math.round(d * 2.5)));
  out.push(...(first ? pts : pts.slice(1)));
}

function gradient(n: number, stops: readonly [string, string, string]): THREE.Color[] {
  const [a, b, c] = stops.map((s) => new THREE.Color(s));
  return Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    return t < 0.5 ? a.clone().lerp(b, t * 2) : b.clone().lerp(c, (t - 0.5) * 2);
  });
}

// Note: drei's <Line> spreads extra props onto both the Line2 and its LineMaterial, so `visible` must not be a prop
// (it would hide the material for good); it is driven per frame on the object instead.
function FlowLine({ points, colors, kw, reduced, thin = false }: {
  points: THREE.Vector3[]; colors: THREE.Color[]; kw: number; reduced: boolean; thin?: boolean;
}) {
  const ref = useRef<LineHandle>(null);
  const s = useRef<SpringState>({ x: 0, v: 0 });
  useFrame((_, dt) => {
    const l = ref.current;
    if (!l) return;
    const on = kw > 0 ? 1 : 0;
    if (reduced) s.current.x = on;
    else stepSpring(s.current, on, dt, SETTLE);
    const o = Math.min(1, Math.max(0, s.current.x));
    l.visible = o > 0.01;
    // subtle: a quiet hint of the flow, not a highway over the model (Mark: the lines looked buggy)
    l.material.opacity = (thin ? 0.38 : 0.62) * o;
    const width = thin ? 1 : 1.3 + Math.min(1.4, kw * 0.25);
    l.material.linewidth = width;
    if (!reduced) l.material.dashOffset -= dt * (0.25 + Math.min(0.7, kw * 0.12));
  });
  return (
    <Line
      ref={ref as never}
      points={points}
      vertexColors={colors}
      color="#ffffff"
      lineWidth={2}
      dashed={!reduced}
      dashSize={0.22}
      gapSize={0.16}
      transparent
      opacity={0}
      depthWrite={false}
      renderOrder={2}
    />
  );
}

// short rays: they hint at the sun without crossing the labels above the roof
const RAY_POINTS = [new THREE.Vector3(0, 4, 0), new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0.15, 0)];
const Y = new THREE.Vector3(0, 1, 0);

function SunRay({ target, sunDir, colors, kw, reduced }: {
  target: THREE.Vector3; sunDir: THREE.Vector3; colors: THREE.Color[]; kw: number; reduced: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = ref.current;
    if (g) g.quaternion.setFromUnitVectors(Y, sunDir);
  });
  return (
    <group ref={ref} position={target}>
      <FlowLine points={RAY_POINTS} colors={colors} kw={kw} reduced={reduced} thin />
    </group>
  );
}

export function EnergyFlow({ flows, nodes, sunDir, rayTargets, gradientStops, reduced }: {
  flows: LiveFlow[];
  nodes: Record<FlowNodeId, THREE.Vector3>;
  /** Unit vector towards the sun, in house coordinates. */
  sunDir: THREE.Vector3;
  /** Points on the panel block that sun rays land on. */
  rayTargets: THREE.Vector3[];
  gradientStops: readonly [string, string, string];
  reduced: boolean;
}) {
  const kw = useMemo(() => Object.fromEntries(flows.map((f) => [f.id, f.kw])), [flows]);

  const lines = useMemo(
    () =>
      Object.entries(FLOW_PATHS).map(([id, path]) => {
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i < path.length - 1; i++) arc(nodes[path[i]], nodes[path[i + 1]], pts, i === 0);
        return { id, points: pts, colors: gradient(pts.length, gradientStops) };
      }),
    [nodes, gradientStops],
  );

  // sun rays: fixed geometry along +y, each turned towards the sun every frame (no line rebuilds while the day plays)
  const rayColors = useMemo(() => gradient(3, [gradientStops[0], gradientStops[0], gradientStops[1]]), [gradientStops]);
  const sunKw = sunDir.y > 0.02 ? (kw["sun-panels"] ?? 0) : 0;

  return (
    <group>
      {lines.map((l) => (
        <FlowLine key={l.id} points={l.points} colors={l.colors} kw={kw[l.id] ?? 0} reduced={reduced} />
      ))}
      {rayTargets.map((t, i) => (
        <SunRay key={i} target={t} sunDir={sunDir} colors={rayColors} kw={sunKw} reduced={reduced} />
      ))}
    </group>
  );
}
