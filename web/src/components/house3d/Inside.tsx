"use client";
import { CameraControls, ContactShadows, Html } from "@react-three/drei";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { BATTERY_MODULE, batteryModuleCount, buildEquipment } from "./equipmentGeometry";
import type { PlanScene } from "./floorPlanLayout";
import { ALLOWED, DEPTH, GENERIC, WALL_Z, ZONE_ORDER, ZONES, slotPosition, type InsideGeo, type InsideKey, type Placement, type Rect, type Zone } from "./insideRules";
import type { Palette } from "./palette";
import { SETTLE, stepSpring, type SpringState } from "./spring";

export interface InsideProps {
  palette: Palette;
  reduced: boolean;
  keys: readonly InsideKey[];
  placement: Placement;
  /** Size text per part for the labels, e.g. "7 kWh". */
  sizes: Partial<Record<InsideKey, string | null>>;
  batteryKwh: number | null;
  /** The viewer let go of `key` at board (x, z). */
  onDrop: (key: InsideKey, x: number, z: number) => void;
  /** An uploaded floor plan's rooms instead of the generic section. */
  plan?: PlanScene | null;
  /** false while hidden: no frames are drawn. */
  active?: boolean;
  onReady?: () => void;
}

const NAME: Record<InsideKey, string> = { battery: "Battery", inverter: "Inverter", heatpump: "Heat pump", wallbox: "Wallbox" };
const DOT: Record<InsideKey, string> = { battery: "bg-comp-battery", inverter: "bg-comp-pv", heatpump: "bg-comp-heatpump", wallbox: "bg-comp-wallbox" };
/** Height above the zone floor: wall-mounted parts hang, the others stand. */
const MOUNT_Y: Record<InsideKey, number> = { battery: 0, inverter: 1.25, heatpump: 0, wallbox: 1.05 };
const LIFT = 0.35; // while dragged
const WALL_H = 2.5;
const PLAN_WALL_H = 1.1; // floor-plan walls: a cutaway, low enough to see into every room
const PLAN_OUTER_H = 1.35;

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

/** The cutaway: a sunk basement, the garage, a piece of outside wall; matte model white like the house. */
function buildRoom(p: Palette) {
  const g = new THREE.Group();
  const wall = new THREE.MeshStandardMaterial({ color: p.wall, roughness: 0.92 });
  const board = new THREE.MeshStandardMaterial({ color: p.floor, roughness: 0.95 });
  const edge = new THREE.MeshStandardMaterial({ color: p.plinth, roughness: 0.95 });
  const paving = new THREE.MeshStandardMaterial({ color: p.paving, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: p.glass, roughness: 0.4 });
  const [z0, z1] = DEPTH;
  const depth = z1 - z0;
  const b = ZONES.basement;
  const bottom = b.floorY - 0.4;
  // ground block with the basement pit cut out (open to the front: a section)
  g.add(box(ZONES.outside.x1 + 0.4 - (b.x1), -bottom, depth, edge, (b.x1 + ZONES.outside.x1 + 0.4) / 2, bottom / 2, (z0 + z1) / 2, false));
  g.add(box(0.4, -bottom, depth, edge, b.x0 - 0.2, bottom / 2, (z0 + z1) / 2, false));
  g.add(box(b.x1 - b.x0, 0.4, depth, edge, (b.x0 + b.x1) / 2, bottom + 0.2, (z0 + z1) / 2, false));
  g.add(box(b.x1 - b.x0, -b.floorY, WALL_Z - z0, edge, (b.x0 + b.x1) / 2, b.floorY / 2, (z0 + WALL_Z) / 2, false));
  // floors: board white indoors, paving outside
  g.add(box(b.x1 - b.x0, 0.02, z1 - WALL_Z, board, (b.x0 + b.x1) / 2, b.floorY + 0.01, (WALL_Z + z1) / 2, false));
  g.add(box(ZONES.outside.x0 - b.x1, 0.02, depth, board, (b.x1 + ZONES.outside.x0) / 2, 0.01, (z0 + z1) / 2, false));
  g.add(box(ZONES.outside.x1 + 0.4 - ZONES.outside.x0, 0.02, depth, paving, (ZONES.outside.x0 + ZONES.outside.x1 + 0.4) / 2, 0.012, (z0 + z1) / 2, false));
  // back wall across basement and garage; a thicker facade outside with a window
  const backX0 = b.x0 - 0.4;
  const backX1 = ZONES.garage.x1 + 0.3;
  g.add(box(backX1 - backX0, WALL_H, 0.3, wall, (backX0 + backX1) / 2, WALL_H / 2, WALL_Z - 0.15));
  g.add(box(ZONES.outside.x1 + 0.4 - backX1, WALL_H + 0.6, 0.4, wall, (backX1 + ZONES.outside.x1 + 0.4) / 2, (WALL_H + 0.6) / 2, WALL_Z - 0.2));
  g.add(box(0.9, 0.9, 0.05, glass, 4.6, 2.2, WALL_Z + 0.01, false));
  // dividers: basement | garage (half height, so the room reads as a section) and garage | outside
  g.add(box(0.3, WALL_H, 2.6, wall, (b.x1 + ZONES.garage.x0) / 2, WALL_H / 2, WALL_Z + 1.3));
  g.add(box(0.3, WALL_H, 2.6, wall, (ZONES.garage.x1 + ZONES.outside.x0) / 2, WALL_H / 2, WALL_Z + 1.3));
  return g;
}

/** An uploaded floor plan as a model: plates, every room's walls extruded (low, a cutaway), the outside strip. */
function buildPlan(p: Palette, plan: PlanScene) {
  const g = new THREE.Group();
  const wall = new THREE.MeshStandardMaterial({ color: p.wall, roughness: 0.92 });
  const floor = new THREE.MeshStandardMaterial({ color: p.floor, roughness: 0.95 });
  const edge = new THREE.MeshStandardMaterial({ color: p.plinth, roughness: 0.95 });
  const paving = new THREE.MeshStandardMaterial({ color: p.paving, roughness: 0.95 });
  const T = 0.1;
  const walls = (r: Rect, h: number, t: number) => {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    g.add(box(w + t, h, t, wall, (r.x0 + r.x1) / 2, h / 2, r.z0));
    g.add(box(w + t, h, t, wall, (r.x0 + r.x1) / 2, h / 2, r.z1));
    g.add(box(t, h, d, wall, r.x0, h / 2, (r.z0 + r.z1) / 2));
    g.add(box(t, h, d, wall, r.x1, h / 2, (r.z0 + r.z1) / 2));
  };
  const slab = (r: Rect, mat: THREE.Material) => {
    g.add(box(r.x1 - r.x0 + 0.3, 0.16, r.z1 - r.z0 + 0.3, edge, (r.x0 + r.x1) / 2, -0.09, (r.z0 + r.z1) / 2, false));
    g.add(box(r.x1 - r.x0, 0.02, r.z1 - r.z0, mat, (r.x0 + r.x1) / 2, 0.0, (r.z0 + r.z1) / 2, false));
  };
  for (const plate of plan.plates) {
    slab(plate.rect, floor);
    for (const room of plate.rooms) walls(room.rect, PLAN_WALL_H, T);
    walls(plate.rect, PLAN_OUTER_H, 0.2);
  }
  for (const x of plan.extras) { slab(x.rect, floor); walls(x.rect, PLAN_WALL_H, T); }
  slab(plan.geo.zones.outside.rect, paving);
  return g;
}

function dispose(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
  });
}

function buildBattery(p: Palette, modules: number) {
  const g = new THREE.Group();
  const housing = new THREE.MeshStandardMaterial({ color: p.appliance, roughness: 0.7 });
  const accent = new THREE.MeshStandardMaterial({ color: p.battery, roughness: 0.4 });
  const { w, h, d } = BATTERY_MODULE;
  g.add(box(w + 0.04, 0.08, d + 0.04, housing, 0, 0.04, d / 2 + 0.02));
  for (let i = 0; i < Math.max(1, modules); i++) {
    g.add(box(w, h - 0.012, d, housing, 0, 0.08 + i * h + h / 2, d / 2 + 0.02));
    g.add(box(w - 0.06, 0.012, 0.006, accent, 0, 0.08 + i * h + 0.03, d + 0.025, false));
  }
  return g;
}

function tint(m: THREE.MeshBasicMaterial, colour: string | null, to: number, dt: number) {
  if (colour) m.color.set(colour);
  m.opacity += (to - m.opacity) * (1 - Math.exp(-12 * Math.min(dt, 0.1)));
}

function setEnabled(c: React.RefObject<CameraControls | null>, on: boolean) {
  if (c.current) c.current.enabled = on;
}

/** Zone floors light up while a part is dragged: allowed zones in the part's colour, the others stay plain. */
function ZoneTint({ zone, active, colour, geo }: { zone: Zone; active: boolean; colour: string; geo: InsideGeo }) {
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  useEffect(() => () => mat.dispose(), [mat]);
  // keep the last colour while fading out, so letting go eases instead of snapping
  useFrame((_, dt) => tint(mat, active ? colour : null, active ? 0.22 : 0, dt));
  const r = geo.zones[zone].rect;
  const y = geo.zones[zone].slots[0][1];
  return (
    <mesh material={mat} position={[(r.x0 + r.x1) / 2, y + 0.03, (r.z0 + r.z1) / 2]} rotation-x={-Math.PI / 2}>
      <planeGeometry args={[r.x1 - r.x0, r.z1 - r.z0]} />
    </mesh>
  );
}

/** Neighbouring slots (also across a zone border) alternate between a label high on the wall and one on the floor. */
const labelHigh = (spot: Placement[InsideKey]) => !!spot && (spot.slot + ZONE_ORDER.indexOf(spot.zone)) % 2 === 1;

const PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const HIT = new THREE.Vector3();

/** One part: springs to its slot, follows the pointer along the wall while dragged. */
function Item({ k, object, placement, size, reduced, settled, onGrab, onDrop, controls, geo, bounds, high }: {
  k: InsideKey; object: THREE.Object3D; placement: Placement; size: string | null | undefined; reduced: boolean; settled: boolean;
  onGrab: (k: InsideKey | null) => void; onDrop: (k: InsideKey, x: number, z: number) => void;
  controls: React.RefObject<CameraControls | null>;
  geo: InsideGeo;
  /** Where a dragged part may go; on the generic section it only slides along the wall. */
  bounds: Rect;
  /** Label on the wall above the part (else on the floor in front of it). */
  high: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  const spot = placement[k];
  const home = useMemo(() => (spot ? slotPosition(spot.zone, spot.slot, geo) : null), [spot, geo]);
  const x = useRef<SpringState | null>(null);
  const y = useRef<SpringState | null>(null);
  const zs = useRef<SpringState | null>(null);
  const free = geo !== GENERIC; // a floor plan: drag anywhere on it
  const yaw = (spot && geo.zones[spot.zone].yaw) || 0;
  const drag = useRef<{ x: number; z: number; dx: number; dz: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g || !home) return;
    const tx = drag.current ? drag.current.x : home[0];
    const tz = (drag.current && free ? drag.current.z : home[2]) + (yaw ? 0 : 0.02);
    const ty = home[1] + MOUNT_Y[k] + (drag.current ? LIFT : 0);
    if (!x.current || !y.current || !zs.current) { x.current = { x: tx, v: 0 }; y.current = { x: ty, v: 0 }; zs.current = { x: tz, v: 0 }; }
    if (reduced || drag.current) { x.current.x = tx; x.current.v = 0; zs.current.x = tz; zs.current.v = 0; }
    else { stepSpring(x.current, tx, dt, SETTLE); stepSpring(zs.current, tz, dt, SETTLE); }
    if (reduced) { y.current.x = ty; y.current.v = 0; } else stepSpring(y.current, ty, dt, SETTLE);
    g.position.set(x.current.x, y.current.x, zs.current.x);
  });

  if (!home) return null;
  const down = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    (e.target as unknown as Element).setPointerCapture?.(e.pointerId);
    e.ray.intersectPlane(PLANE, HIT);
    const px = ref.current?.position.x ?? home[0];
    const pz = ref.current?.position.z ?? home[2];
    drag.current = { x: px, z: pz, dx: px - HIT.x, dz: pz - HIT.z };
    setEnabled(controls, false);
    setDragging(true);
    onGrab(k);
    document.body.style.cursor = "grabbing";
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    if (!e.ray.intersectPlane(PLANE, HIT)) return;
    drag.current.x = Math.min(bounds.x1, Math.max(bounds.x0, HIT.x + drag.current.dx));
    drag.current.z = Math.min(bounds.z1, Math.max(bounds.z0, HIT.z + drag.current.dz));
  };
  const up = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    (e.target as unknown as Element).releasePointerCapture?.(e.pointerId);
    const at = drag.current;
    drag.current = null;
    setEnabled(controls, true);
    setDragging(false);
    onGrab(null);
    document.body.style.cursor = "";
    onDrop(k, at.x, at.z);
  };

  return (
    <group
      ref={ref}
      rotation-y={yaw}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerOver={() => { if (!drag.current) document.body.style.cursor = "grab"; }}
      onPointerOut={() => { if (!drag.current) document.body.style.cursor = ""; }}
    >
      <primitive object={object} />
      {/* labels alternate between the floor in front of the part and the wall above it, so neighbours never
          collide, also on narrow stages (two side by side on /reality) */}
      {settled && (
        <Html position={free
          // a floor plan: every label above the walls, staggered by slot, so neighbours never overlap
          ? [0, PLAN_WALL_H + 0.5 + 0.6 * (spot?.slot ?? 0) - MOUNT_Y[k], 0.15]
          // the section: above the back wall, alternating two heights, clear of the zone names on the floor
          : [0, WALL_H + 0.3 + (high ? 0.6 : 0) - MOUNT_Y[k], 0.15]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div className={`hidden w-max flex-col items-center rounded-md sm:flex border border-border bg-surface-1/95 px-2 py-1 text-ink shadow-[0_6px_18px_rgba(16,17,20,0.12)] transition-transform duration-150 ${dragging ? "scale-105" : ""}`}>
            <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-4">
              <span aria-hidden className={`size-2 rounded-full ${DOT[k]}`} />
              {NAME[k]}
            </span>
            {size && <span className="font-mono text-[12px] leading-4 tabular-nums text-ink-body">{size}</span>}
          </div>
        </Html>
      )}
    </group>
  );
}

const COLOUR = (p: Palette): Record<InsideKey, string> => ({ battery: p.battery, inverter: p.pv, heatpump: p.heatpump, wallbox: p.wallbox });

export default function Inside({ palette, reduced, keys, placement, sizes, batteryKwh, onDrop, onReady, plan = null, active = true }: InsideProps) {
  const room = useMemo(() => (plan ? buildPlan(palette, plan) : buildRoom(palette)), [palette, plan]);
  const geo = plan?.geo ?? GENERIC;
  const bounds: Rect = plan
    ? { x0: plan.centre[0] - plan.span / 2, z0: plan.centre[1] - plan.span / 2, x1: plan.centre[0] + plan.span / 2, z1: plan.centre[1] + plan.span / 2 }
    : { x0: ZONES.basement.x0, z0: WALL_Z, x1: ZONES.outside.x1, z1: WALL_Z };
  // labels alternate high/low; on a plan, per zone in slot order (neighbours in a room never share a height)
  const high = (k: InsideKey) => {
    const spot = placement[k];
    if (!spot) return false;
    if (!plan) return labelHigh(spot);
    return spot.slot % 2 === 1;
  };
  const span = plan?.span ?? 12;
  useEffect(() => () => dispose(room), [room]);
  const equipment = useMemo(() => buildEquipment(palette), [palette]);
  useEffect(() => () => Object.values(equipment).forEach(dispose), [equipment]);
  const modules = batteryModuleCount(batteryKwh);
  const battery = useMemo(() => buildBattery(palette, modules), [palette, modules]);
  useEffect(() => () => dispose(battery), [battery]);
  const objects: Record<InsideKey, THREE.Object3D> = { battery, inverter: equipment.inverter, heatpump: equipment.heatpump, wallbox: equipment.wallbox };
  const [grabbed, setGrabbed] = useState<InsideKey | null>(null);
  // drei's Html mounted in the very first commit can lose its root; mount labels a frame later
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  const controls = useRef<CameraControls>(null);
  const colours = COLOUR(palette);
  useEffect(() => () => { document.body.style.cursor = ""; }, []);

  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      shadows
      dpr={[1, 2]}
      camera={{ fov: 30, near: 0.5, far: 120, position: [1.6, 9.5, 17.5] }}
      gl={{ antialias: true, alpha: true }}
      onCreated={({ gl }) => { gl.toneMapping = THREE.NeutralToneMapping; onReady?.(); }}
      style={{ touchAction: "pan-y" }}
    >
      <hemisphereLight args={["#ffffff", palette.groundBounce, 1.7]} />
      <directionalLight position={[-5, 12, 10]} intensity={1.6} color="#fffaf2" castShadow shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-span * 0.8} shadow-camera-right={span * 0.8} shadow-camera-top={span * 0.8} shadow-camera-bottom={-span * 0.8} shadow-camera-far={span * 4 + 20} shadow-bias={-0.0004} />
      <primitive object={room} />
      {ZONE_ORDER.map((z) => (
        <ZoneTint key={z} zone={z} geo={geo} active={!!grabbed && ALLOWED[grabbed].includes(z)} colour={grabbed ? colours[grabbed] : palette.border} />
      ))}
      {/* drei's first Html in a canvas can lose its root under React 19: a placeholder takes that hit */}
      {settled && <Html position={[0, -50, 0]} style={{ display: "none" }}><span /></Html>}
      {settled && !plan && ZONE_ORDER.map((z) => (
        <Html key={z} position={[(ZONES[z].x0 + ZONES[z].x1) / 2, ZONES[z].floorY + 0.05, DEPTH[1] - 0.3]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <span className="whitespace-nowrap text-[13px] font-medium uppercase tracking-[0.08em] text-ink-muted">{ZONES[z].label}</span>
        </Html>
      ))}
      {/* a floor plan: every room's name on its floor, towards the front so parts at the back wall never cover it */}
      {settled && plan && [
        ...plan.plates.flatMap((pl) => pl.rooms.map((r) => ({ key: `${pl.title}:${r.name}:${r.rect.x0}:${r.rect.z0}`, label: r.name, rect: r.rect, strong: false }))),
        ...plan.extras.map((x) => ({ key: `extra:${x.zone}`, label: x.label, rect: x.rect, strong: false })),
        { key: "outside", label: "Outside wall", rect: plan.geo.zones.outside.rect, strong: false },
        ...plan.plates.map((pl) => ({ key: `plate:${pl.title}`, label: pl.title, rect: { ...pl.rect, z0: pl.rect.z0 - 1.2, z1: pl.rect.z0 - 0.2 }, strong: true })),
      ].map((l) => (
        <Html key={l.key} position={[(l.rect.x0 + l.rect.x1) / 2, 0.05, l.strong ? (l.rect.z0 + l.rect.z1) / 2 : l.rect.z0 + (l.rect.z1 - l.rect.z0) * 0.62]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <span className={l.strong
            ? "whitespace-nowrap text-[13px] font-semibold text-ink"
            : "block max-w-[9rem] truncate whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted"}>{l.label}</span>
        </Html>
      ))}
      {keys.map((k) => (
        <Item key={k} k={k} object={objects[k]} placement={placement} size={sizes[k]} reduced={reduced} settled={settled} onGrab={setGrabbed} onDrop={onDrop} controls={controls} geo={geo} bounds={bounds} high={high(k)} />
      ))}
      <ContactShadows position={[plan?.centre[0] ?? 0, 0.02, plan?.centre[1] ?? 0]} scale={Math.max(16, span * 1.3)} resolution={512} blur={2.4} far={4} opacity={0.3} frames={reduced ? 1 : Infinity} color="#1b1d20" />
      <CameraControls
        ref={controls}
        makeDefault
        minDistance={plan ? span * 0.6 : 12}
        maxDistance={plan ? span * 2.4 : 28}
        minPolarAngle={0.5}
        maxPolarAngle={1.25}
        minAzimuthAngle={-0.7}
        maxAzimuthAngle={0.7}
        truckSpeed={0}
      />
      <LookAt controls={controls} plan={plan} />
    </Canvas>
  );
}

function LookAt({ controls, plan }: { controls: React.RefObject<CameraControls | null>; plan: PlanScene | null }) {
  useEffect(() => {
    if (!plan) { void controls.current?.setLookAt(1.6, 9.5, 17.5, 0.2, -0.2, -0.2, false); return; }
    // from the front, high enough to look into every room; far enough that the whole plan fits
    const [cx, cz] = plan.centre;
    const d = plan.span * 1.3;
    void controls.current?.setLookAt(cx + d * 0.08, d * 0.78, cz + d * 0.62, cx, 0, cz + 0.4, false);
  }, [controls, plan]);
  return null;
}
