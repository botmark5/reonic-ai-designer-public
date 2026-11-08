"use client";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { BATTERY_MODULE, MAX_BATTERY_MODULES, buildBatteryParts } from "./equipmentGeometry";
import { slotToWorld, type Mount, type PlaneFrame } from "./houseGeometry";
import { isExisting, PANEL, type PanelSlot, type PlaneId } from "./layout";
import { nearestFree } from "./panelEdit";
import type { Palette } from "./palette";
import type { CompKey } from "./sceneSpec";
import { LAND, ROLL, SETTLE, stepSpring, type SpringState } from "./spring";

export interface Pointer {
  onOver: (key: CompKey) => void;
  onOut: (key: CompKey) => void;
  onTap: (key: CompKey) => void;
}

function handlers(key: CompKey, p: Pointer) {
  return {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); p.onOver(key); },
    onPointerOut: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); p.onOut(key); },
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); p.onTap(key); },
  };
}

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const list: THREE.Material[] = [];
  object.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) list.push(...(Array.isArray(m) ? m : [m]));
  });
  return list;
}

function setOpacity(list: THREE.Material[], v: number) {
  for (const m of list) {
    m.opacity = v;
    // opaque when settled: correct sorting and no transparency cost at rest
    const t = v < 0.999;
    if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
  }
}

/**
 * Settles its object in (rises a little, scales from 0.92, fades) when `visible` turns true, and back out when false.
 * Critically damped spring, interruptible. Hidden once fully out; not hit-testable while hidden.
 */
export function Appear({ object, mount, visible, reduced, intro = true, delay = 0, ghostFor = 0, ghostOnly = false, hitKey, pointer }: {
  object: THREE.Object3D; mount: Mount; visible: boolean; reduced: boolean; intro?: boolean; delay?: number;
  /** Seconds it first stands as a translucent ghost before turning solid (the /live heat pump). */
  ghostFor?: number;
  /** Stays a ghost (an option the design does not include). */
  ghostOnly?: boolean;
  hitKey: CompKey; pointer: Pointer;
}) {
  const ref = useRef<THREE.Group>(null);
  const s = useRef<SpringState>({ x: 0, v: 0 });
  const wait = useRef(delay);
  const ghost = useRef(0);
  const first = useRef(true);
  const mats = useRef<{ of: THREE.Object3D; list: THREE.Material[] } | null>(null);

  useEffect(() => {
    wait.current = visible ? delay : 0;
    ghost.current = visible && !first.current ? ghostFor : 0;
  }, [visible, delay, ghostFor]);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (mats.current?.of !== object) mats.current = { of: object, list: materialsOf(object) };
    if (ghost.current > 0 && wait.current <= 0) ghost.current -= dt;
    const target = visible ? (ghostOnly || (ghost.current > 0 && !reduced) ? GHOST : 1) : 0;
    const snap = reduced || (first.current && !intro);
    first.current = false;
    if (snap) { s.current.x = target; s.current.v = 0; }
    else if (wait.current > 0) wait.current -= dt;
    else stepSpring(s.current, target, dt, SETTLE);
    const v = Math.min(1, Math.max(0, s.current.x));
    g.visible = v > 0.01;
    g.scale.setScalar(0.92 + 0.08 * v);
    g.position.set(mount.position.x, mount.position.y - (1 - v) * 0.15, mount.position.z);
    setOpacity(mats.current.list, v);
  });

  return (
    <group ref={ref} rotation-y={mount.yaw} visible={false} {...(visible ? handlers(hitKey, pointer) : {})}>
      <primitive object={object} />
    </group>
  );
}

const GHOST = 0.32;

/**
 * A layer of the house for the /live build-up: the shell rises out of the board, the roof settles onto it.
 * Transform only (the layers share materials). Shown from the first frame unless `shown` starts false.
 */
export function Layer({ object, shown, kind, reduced }: {
  object: THREE.Object3D; shown: boolean; kind: "rise" | "settle"; reduced: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  const s = useRef<SpringState | null>(null);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    const target = shown ? 1 : 0;
    if (!s.current || reduced) s.current = { x: target, v: 0 };
    else stepSpring(s.current, target, dt, kind === "rise" ? SETTLE : LAND);
    const v = s.current.x;
    g.visible = v > 0.01;
    if (kind === "rise") g.scale.y = Math.max(0.001, Math.min(1.02, v));
    else g.position.y = (1 - v) * 3.2;
  });
  return (
    <group ref={ref}>
      <primitive object={object} />
    </group>
  );
}

const WARM = new THREE.Color("#ffb766");

/** Windows warm up: a soft emissive glow springs in when `on` turns true. */
export function WarmWindows({ glass, on, reduced }: { glass: THREE.MeshStandardMaterial; on: boolean; reduced: boolean }) {
  const s = useRef<SpringState | null>(null);
  const mat = useRef<THREE.MeshStandardMaterial | null>(null);
  useEffect(() => { mat.current = glass; }, [glass]);
  useFrame((_, dt) => {
    const m = mat.current;
    if (!m) return;
    const target = on ? 1 : 0;
    if (!s.current || reduced) s.current = { x: target, v: 0 };
    else stepSpring(s.current, target, dt, SETTLE);
    m.emissive.copy(WARM);
    m.emissiveIntensity = Math.max(0, s.current.x) * 0.4; // a soft glow: in daylight more reads as orange paint
  });
  return null;
}

// ---------- panels ----------

function panelTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 200;
  const x = c.getContext("2d")!;
  x.fillStyle = "#ffffff";
  x.fillRect(0, 0, 128, 200);
  x.strokeStyle = "rgba(120,140,170,0.22)";
  x.lineWidth = 1.5;
  for (let i = 1; i < 6; i++) { x.beginPath(); x.moveTo((i * 128) / 6, 0); x.lineTo((i * 128) / 6, 200); x.stroke(); }
  for (let j = 1; j < 10; j++) { x.beginPath(); x.moveTo(0, j * 20); x.lineTo(128, j * 20); x.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface PanelState {
  slot: PanelSlot; drop: SpringState; target: 0 | 1; wait: number; row: number;
  /** Where the panel is drawn (glides to `slot` after a move, a repack or a drop). */
  at: { plane: PlaneId; u: number; v: number };
  lift: number;
}

const ROW_STAGGER = 0.11;
const COL_STAGGER = 0.016;
const DROP = 1.3; // metres above the roof a new panel starts from
const PANEL_LIFT = 0.13;

const rowOf = (s: PanelSlot) => Number(/-r(\d+)u/.exec(s.id)?.[1] ?? 0) + (s.plane === "garage" ? 4 : 0);

/** New panels drop in row by row from the gutter up and land with a slight bounce; removed ones lift away, top row first. */
function syncSlots(map: Map<string, PanelState>, slots: PanelSlot[], reduced: boolean) {
  const ids = new Set(slots.map((s) => s.id));
  const fresh = slots.filter((s) => !map.has(s.id) || map.get(s.id)!.target === 0);
  const colInRow = new Map<number, number>();
  for (const s of fresh) {
    const row = rowOf(s);
    const col = colInRow.get(row) ?? 0;
    colInRow.set(row, col + 1);
    const wait = reduced ? 0 : row * ROW_STAGGER + col * COL_STAGGER;
    const st = map.get(s.id);
    if (st) { st.target = 1; st.wait = wait; st.slot = s; }
    else map.set(s.id, { slot: s, drop: { x: reduced ? 0 : 1, v: 0 }, target: 1, wait, row, at: { plane: s.plane, u: s.u, v: s.v }, lift: 0 });
  }
  for (const s of slots) { const st = map.get(s.id); if (st) st.slot = s; }
  const leaving = [...map.values()].filter((st) => !ids.has(st.slot.id) && st.target === 1);
  const maxRow = Math.max(0, ...leaving.map((st) => st.row));
  for (const st of leaving) { st.target = 0; st.wait = reduced ? 0 : (maxRow - st.row) * 0.06; }
}

const SCRATCH = {
  m4: new THREE.Matrix4(), basis: new THREE.Matrix4(), scale: new THREE.Vector3(),
  pos: new THREE.Vector3(), q: new THREE.Quaternion(), back: new THREE.Vector3(),
};

/** Planner editing: pick a panel, drag it to a free spot (ghost preview), the parent owns the list. */
export interface PanelEditing {
  selected: string | null;
  grid: PanelSlot[];
  /** Panels already on the roof: they stay where they are. */
  locked: ReadonlySet<string>;
  onPick: (id: string | null) => void;
  onMove: (id: string, to: PanelSlot) => void;
}

const PICK_LIFT = 0.06; // the picked panel rises a little off the roof, inside its outline
const DRAG_LIFT = 0.22; // the dragged panel floats above the roof, under the pointer
const GLIDE = 16; // 1/s: a dropped or repacked panel glides to its slot in about 0.2 s
const PLAIN = new THREE.Color("#ffffff");
/** Panels already on the roof: a few years of weather, so the proposal's fresh panels stand out next to them. */
const EXISTING_TINT = new THREE.Color("#b4bac6");
const SELECT = "#f2a516";
const OUTLINE = 0.055; // outline width, metres
const HANDLE_R = 0.09;
const LOCAL = { inv: new THREE.Matrix4(), ray: new THREE.Ray(), plane: new THREE.Plane(), hit: new THREE.Vector3(), d: new THREE.Vector3() };

function setControls(c: unknown, on: boolean) {
  const ctl = c as { enabled?: boolean } | null;
  if (ctl && "enabled" in ctl) ctl.enabled = on;
}

/** All panels as one InstancedMesh (glass) + one for frames. Dark glass with clearcoat catches the sun. */
export function Panels({ slots, frames, palette, reduced, intro = true, pointer, maxCount = 96, edit }: {
  slots: PanelSlot[]; frames: Record<PanelSlot["plane"], PlaneFrame>; palette: Palette; reduced: boolean;
  intro?: boolean; pointer: Pointer; maxCount?: number; edit?: PanelEditing | null;
}) {
  const order = useRef<string[]>([]);
  const controls = useThree((st) => st.controls);
  // the panel being dragged: where the pointer holds it (`free`, follows 1:1 with the grab offset) and the free spot
  // it snaps to on release (`to`, the one ghost)
  const drag = useRef<{
    id: string; x: number; y: number; moved: boolean; to: PanelSlot | null;
    off: { plane: PlaneId; u: number; v: number } | null; free: { plane: PlaneId; u: number; v: number } | null; wasPicked: boolean;
  } | null>(null);
  const [ghost, setGhost] = useState<PanelSlot | null>(null);
  // editing switched off (or unmount) mid-drag: never leave the orbit disabled or the cursor grabbing
  const editing = !!edit;
  useEffect(() => () => {
    drag.current = null;
    setControls(controls, true);
    document.body.style.cursor = "";
  }, [controls, editing]);
  const glass = useRef<THREE.InstancedMesh>(null);
  const rim = useRef<THREE.InstancedMesh>(null);
  const states = useRef(new Map<string, PanelState>());
  const latest = useRef<PanelSlot[]>(slots);
  const synced = useRef<PanelSlot[] | null>(null);
  const atRest = useRef<{ frames: unknown; geo: unknown; picked: string | null } | null>(null);
  useEffect(() => { latest.current = slots; }, [slots]);

  const { glassGeo, rimGeo, glassMats, rimMat } = useMemo(() => {
    const top = new THREE.MeshPhysicalMaterial({
      color: palette.panel, map: panelTexture(), roughness: 0.32, metalness: 0.05,
      clearcoat: 0.6, clearcoatRoughness: 0.12, envMapIntensity: 0.45,
    });
    const side = new THREE.MeshStandardMaterial({ color: palette.panelFrame, roughness: 0.45, metalness: 0.5 });
    return {
      glassGeo: new THREE.BoxGeometry(PANEL.w - 0.035, 0.035, PANEL.h - 0.035),
      rimGeo: new THREE.BoxGeometry(PANEL.w, 0.03, PANEL.h),
      glassMats: [side, side, top, side, side, side],
      rimMat: side,
    };
  }, [palette]);

  useEffect(() => () => {
    glassGeo.dispose(); rimGeo.dispose();
    for (const m of new Set(glassMats)) { (m as THREE.MeshStandardMaterial).map?.dispose(); m.dispose(); }
  }, [glassGeo, rimGeo, glassMats, rimMat]);

  useFrame((_, dt) => {
    if (!glass.current || !rim.current) return;
    if (synced.current !== latest.current) {
      syncSlots(states.current, latest.current, reduced || (synced.current === null && !intro));
      synced.current = latest.current;
      atRest.current = null;
    }
    // nothing moving and nothing changed: the instance matrices are already right
    const picked = edit?.selected ?? null;
    const held = drag.current?.moved && drag.current.free ? drag.current : null;
    if (!held && atRest.current && atRest.current.frames === frames && atRest.current.geo === glassGeo && atRest.current.picked === picked) return;
    const { m4, basis, scale, pos, q, back } = SCRATCH;
    let i = 0;
    let moving = false;
    for (const [id, st] of states.current) {
      const target = st.target === 1 ? 0 : 1; // drop offset: 0 = on the roof, 1 = up in the air
      if (reduced || (st.wait <= 0 && st.drop.x === target && st.drop.v === 0)) { st.drop.x = target; st.drop.v = 0; }
      else if (st.wait > 0) { st.wait -= dt; moving = true; }
      else { stepSpring(st.drop, target, dt, st.target === 1 ? LAND : SETTLE); moving = true; }
      if (st.target === 0 && st.drop.x >= 0.995) { states.current.delete(id); continue; }
      if (i >= maxCount) continue;
      // where it is drawn: under the pointer while held, else gliding to its slot (after a drop, move or repack)
      const hold = held && held.id === id ? held.free! : null;
      const goal = hold ?? st.slot;
      const liftGoal = hold ? DRAG_LIFT : id === picked ? PICK_LIFT : 0;
      if (hold || reduced || st.at.plane !== goal.plane) st.at = { plane: goal.plane, u: goal.u, v: goal.v };
      else {
        const k = 1 - Math.exp(-dt * GLIDE);
        st.at.u += (goal.u - st.at.u) * k;
        st.at.v += (goal.v - st.at.v) * k;
        if (Math.abs(goal.u - st.at.u) + Math.abs(goal.v - st.at.v) < 1e-3) { st.at.u = goal.u; st.at.v = goal.v; } else moving = true;
      }
      if (reduced) st.lift = liftGoal;
      else {
        st.lift += (liftGoal - st.lift) * (1 - Math.exp(-dt * GLIDE));
        if (Math.abs(liftGoal - st.lift) < 1e-3) st.lift = liftGoal; else moving = true;
      }
      const f = frames[st.at.plane];
      const up = st.drop.x; // may dip slightly below 0 on landing: the bounce
      const v = Math.min(1, Math.max(0, 1 - up));
      pos.copy(slotToWorld(f, st.at.u, st.at.v, PANEL_LIFT + up * DROP + st.lift));
      back.copy(f.vAxis).negate();
      q.setFromRotationMatrix(basis.makeBasis(f.uAxis, f.normal, back));
      scale.setScalar(v < 0.02 ? 0 : 0.94 + 0.06 * v);
      m4.compose(pos, q, scale);
      glass.current.setMatrixAt(i, m4);
      glass.current.setColorAt(i, isExisting(id) ? EXISTING_TINT : PLAIN);
      order.current[i] = id;
      pos.addScaledVector(f.normal, -0.01);
      m4.compose(pos, q, scale);
      rim.current.setMatrixAt(i, m4);
      i++;
    }
    glass.current.count = i;
    rim.current.count = i;
    glass.current.instanceMatrix.needsUpdate = true;
    if (glass.current.instanceColor) glass.current.instanceColor.needsUpdate = true;
    rim.current.instanceMatrix.needsUpdate = true;
    glass.current.computeBoundingSphere();
    rim.current.computeBoundingSphere();
    atRest.current = moving || held ? null : { frames, geo: glassGeo, picked };
  });

  /** Where the pointer ray meets the roof (plane coordinates): the preferred plane first, then the other one. */
  const planeHit = (ray: THREE.Ray, prefer: PlaneId): { plane: PlaneId; u: number; v: number } | null => {
    const g = glass.current;
    if (!g) return null;
    LOCAL.inv.copy(g.matrixWorld).invert();
    LOCAL.ray.copy(ray).applyMatrix4(LOCAL.inv);
    for (const plane of [prefer, prefer === "main" ? "garage" : "main"] as PlaneId[]) {
      const f = frames[plane];
      LOCAL.plane.setFromNormalAndCoplanarPoint(f.normal, f.origin);
      if (!LOCAL.ray.intersectPlane(LOCAL.plane, LOCAL.hit)) continue;
      LOCAL.d.copy(LOCAL.hit).sub(f.origin);
      const u = LOCAL.d.dot(f.uAxis);
      const v = LOCAL.d.dot(f.vAxis);
      if (Math.abs(u) > f.plane.width / 2 + 0.5 || v < -0.5 || v > f.plane.slope + 0.5) continue;
      return { plane, u, v };
    }
    return null;
  };
  const endDrag = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d) return null;
    e.stopPropagation();
    drag.current = null;
    (e.target as unknown as Element).releasePointerCapture?.(e.pointerId);
    setControls(controls, true);
    setGhost(null);
    document.body.style.cursor = "";
    return d;
  };
  const editHandlers = edit ? {
    onPointerDown: (e: ThreeEvent<PointerEvent>) => {
      const id = e.instanceId !== undefined ? order.current[e.instanceId] : undefined;
      if (!id || edit.locked.has(id)) return; // existing panels: let the camera orbit instead
      e.stopPropagation();
      (e.target as unknown as Element).setPointerCapture?.(e.pointerId);
      const from = slots.find((s) => s.id === id);
      const hit = from ? planeHit(e.ray, from.plane) : null;
      // grab offset: the panel keeps the spot under the pointer where it was grabbed
      const off = from && hit && hit.plane === from.plane ? { plane: from.plane, u: hit.u - from.u, v: hit.v - from.v } : null;
      drag.current = { id, x: e.clientX, y: e.clientY, moved: false, to: null, off, free: null, wasPicked: edit.selected === id };
      setControls(controls, false);
      // grabbing selects (one highlight; the flows step aside)
      if (edit.selected !== id) edit.onPick(id);
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      const d = drag.current;
      if (!d) { if (edit && e.instanceId !== undefined && !edit.locked.has(order.current[e.instanceId] ?? "")) document.body.style.cursor = "grab"; return; }
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.moved = true;
      const from = slots.find((s) => s.id === d.id);
      const hit = from ? planeHit(e.ray, d.free?.plane ?? from.plane) : null;
      if (hit) {
        const off = d.off && d.off.plane === hit.plane ? d.off : { u: 0, v: 0 };
        d.free = { plane: hit.plane, u: hit.u - off.u, v: hit.v - off.v };
        const to = nearestFree(slots, edit.grid, hit.plane, d.free.u, d.free.v, d.id, true);
        if (to?.id !== d.to?.id) { d.to = to; setGhost(to); }
      }
      document.body.style.cursor = "grabbing";
    },
    onPointerOut: () => { if (!drag.current) document.body.style.cursor = ""; },
    onPointerUp: (e: ThreeEvent<PointerEvent>) => {
      const d = endDrag(e);
      if (!d) return;
      if (d.moved && d.to) edit.onMove(d.id, d.to);
      else if (!d.moved && d.wasPicked) edit.onPick(null);
    },
    // a touch that turns into a page scroll, or a lost capture: drop the drag, move nothing
    onPointerCancel: (e: ThreeEvent<PointerEvent>) => { endDrag(e); },
    onLostPointerCapture: (e: ThreeEvent<PointerEvent>) => { endDrag(e); },
  } : {};

  const poseOf = (slot: PanelSlot, lift: number) => {
    const f = frames[slot.plane];
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.uAxis, f.normal, f.vAxis.clone().negate()));
    return { pos: slotToWorld(f, slot.u, slot.v, lift), q };
  };
  const ghostAt = ghost ? poseOf(ghost, PANEL_LIFT) : null;
  const pickedSlot = edit?.selected ? slots.find((x) => x.id === edit.selected) : undefined;
  // while dragging, the ghost is the only highlight
  const pickedAt = pickedSlot && !ghost ? poseOf(pickedSlot, PANEL_LIFT + PICK_LIFT + 0.03) : null;
  const ow = PANEL.w / 2 + OUTLINE / 2;
  const oh = PANEL.h / 2 + OUTLINE / 2;

  return (
    <group {...(edit ? {} : handlers("pv", pointer))}>
      <instancedMesh ref={glass} args={[glassGeo, glassMats, maxCount]} castShadow receiveShadow frustumCulled={false} {...editHandlers} />
      {pickedAt && (
        // a clean outline around the whole panel, round handles at the corners
        <group position={pickedAt.pos} quaternion={pickedAt.q}>
          {([[0, oh, PANEL.w + 2 * OUTLINE, OUTLINE], [0, -oh, PANEL.w + 2 * OUTLINE, OUTLINE], [ow, 0, OUTLINE, PANEL.h], [-ow, 0, OUTLINE, PANEL.h]] as const).map(([x, z, w, h], k) => (
            <mesh key={k} position={[x, 0, z]} raycast={() => null} renderOrder={2}>
              <boxGeometry args={[w, 0.012, h]} />
              <meshBasicMaterial color={SELECT} toneMapped={false} />
            </mesh>
          ))}
          {([[ow, oh], [-ow, oh], [ow, -oh], [-ow, -oh]] as const).map(([x, z], k) => (
            <group key={`h${k}`} position={[x, 0.01, z]}>
              <mesh raycast={() => null} renderOrder={2}>
                <cylinderGeometry args={[HANDLE_R, HANDLE_R, 0.02, 20]} />
                <meshBasicMaterial color={SELECT} toneMapped={false} />
              </mesh>
              <mesh position={[0, 0.006, 0]} raycast={() => null} renderOrder={3}>
                <cylinderGeometry args={[HANDLE_R * 0.55, HANDLE_R * 0.55, 0.02, 20]} />
                <meshBasicMaterial color="#ffffff" toneMapped={false} />
              </mesh>
            </group>
          ))}
        </group>
      )}
      {ghostAt && (
        <mesh position={ghostAt.pos} quaternion={ghostAt.q} raycast={() => null}>
          <boxGeometry args={[PANEL.w, 0.04, PANEL.h]} />
          <meshBasicMaterial color={SELECT} transparent opacity={0.4} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      <instancedMesh ref={rim} args={[rimGeo, rimMat, maxCount]} castShadow frustumCulled={false} />
    </group>
  );
}

// ---------- battery ----------

const MAX_MODULES = MAX_BATTERY_MODULES;

/** Stacked battery modules; modules stack in/out one by one, the side gauge springs to the state of charge. */
export function Battery({ mount, modules, soc, palette, reduced, intro = true, pointer }: {
  mount: Mount; modules: number; soc: number; palette: Palette; reduced: boolean; intro?: boolean; pointer: Pointer;
}) {
  const parts = useMemo(() => buildBatteryParts(palette), [palette]);
  useEffect(() => () => {
    for (const v of Object.values(parts)) (v as THREE.BufferGeometry | THREE.Material).dispose();
  }, [parts]);
  const refs = useRef<(THREE.Group | null)[]>([]);
  const base = useRef<THREE.Mesh>(null);
  const gauge = useRef<THREE.Mesh>(null);
  const track = useRef<THREE.Mesh>(null);
  const springs = useRef(Array.from({ length: MAX_MODULES }, () => ({ s: { x: 0, v: 0 } as SpringState, wait: 0, target: 0 })));
  const height = useRef<SpringState>({ x: 0, v: 0 });
  const fill = useRef<SpringState>({ x: soc, v: 0 });
  const seen = useRef(-1);

  useFrame((_, dt) => {
    // module targets: stack bottom-up when adding, top-down when removing
    const snap = reduced || (seen.current === -1 && !intro);
    if (seen.current !== modules) {
      const prev = Math.max(0, seen.current);
      for (let i = 0; i < MAX_MODULES; i++) {
        const sp = springs.current[i];
        const t = i < modules ? 1 : 0;
        if (sp.target !== t) {
          sp.target = t;
          sp.wait = snap ? 0 : t ? (i - prev) * 0.09 : (prev - 1 - i) * 0.07;
          if (snap) { sp.s.x = t; sp.s.v = 0; }
        }
      }
      seen.current = modules;
    }
    const { h } = BATTERY_MODULE;
    let stack = 0;
    for (let i = 0; i < MAX_MODULES; i++) {
      const sp = springs.current[i];
      const g = refs.current[i];
      if (reduced) { sp.s.x = sp.target; sp.s.v = 0; }
      else if (sp.wait > 0) sp.wait -= dt;
      else stepSpring(sp.s, sp.target, dt, sp.target ? LAND : SETTLE);
      const v = Math.min(1, Math.max(0, sp.s.x));
      if (g) {
        g.visible = v > 0.01;
        g.position.y = 0.08 + i * h + (1 - sp.s.x) * 0.35;
        g.scale.setScalar(0.94 + 0.06 * v);
      }
      stack += v;
    }
    const totalH = Math.max(0, stack) * h;
    if (reduced) height.current.x = totalH;
    else stepSpring(height.current, totalH, dt, SETTLE);
    if (snap) { height.current.x = totalH; fill.current.x = soc; }
    else stepSpring(fill.current, soc, dt, SETTLE);
    const H = Math.max(0.001, height.current.x - 0.06);
    if (track.current) { track.current.scale.y = H; track.current.position.y = 0.11 + H / 2; track.current.visible = modules > 0; }
    if (gauge.current) {
      const f = Math.min(1, Math.max(0.001, fill.current.x)) * H;
      gauge.current.scale.y = f;
      gauge.current.position.y = 0.11 + f / 2;
      gauge.current.visible = modules > 0;
    }
    if (base.current) base.current.visible = stack > 0.01;
  });

  const { w, d } = BATTERY_MODULE;
  return (
    <group position={mount.position} rotation-y={mount.yaw} {...(modules > 0 ? handlers("battery", pointer) : {})}>
      <mesh ref={base} geometry={parts.base} material={parts.plinth} position={[0, 0.04, d / 2]} castShadow receiveShadow />
      {Array.from({ length: MAX_MODULES }, (_, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el; }} visible={false}>
          <mesh geometry={parts.module} material={parts.housing} position={[0, BATTERY_MODULE.h / 2, d / 2]} castShadow receiveShadow />
          <mesh geometry={parts.seam} material={parts.accent} position={[0, 0.02, d + 0.002]} />
        </group>
      ))}
      <mesh ref={track} geometry={parts.gauge} material={parts.gaugeTrack} position={[w / 2 - 0.06, 0.2, d + 0.006]} />
      <mesh ref={gauge} geometry={parts.gauge} material={parts.accent} position={[w / 2 - 0.06, 0.2, d + 0.01]} />
    </group>
  );
}

// ---------- car ----------

const tangent = new THREE.Vector3();

/** The car drives in from the street along `path` when the wallbox is added, and back out when it's removed. */
export function Car({ object, path, visible, reduced, intro = true, pointer }: {
  object: THREE.Object3D; path: THREE.Curve<THREE.Vector3>; visible: boolean; reduced: boolean; intro?: boolean; pointer: Pointer;
}) {
  const ref = useRef<THREE.Group>(null);
  const s = useRef<SpringState>({ x: 0, v: 0 });
  const last = useRef(0);
  const first = useRef(true);
  const cache = useRef<{ of: THREE.Object3D; mats: THREE.Material[]; wheels: THREE.Object3D[] } | null>(null);
  const length = useMemo(() => path.getLength(), [path]);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    if (cache.current?.of !== object) {
      cache.current = { of: object, mats: materialsOf(object), wheels: object.children.filter((c) => c.name === "wheel") };
    }
    const target = visible ? 1 : 0;
    if (reduced || (first.current && !intro)) { s.current.x = target; s.current.v = 0; last.current = target; }
    else stepSpring(s.current, target, dt, ROLL);
    first.current = false;
    const k = Math.min(1, Math.max(0, s.current.x));
    g.visible = k > 0.002;
    path.getPointAt(k, g.position);
    path.getTangentAt(k, tangent);
    g.rotation.y = Math.atan2(-tangent.x, -tangent.z); // nose (local -z) along the path
    const rolled = (k - last.current) * length;
    last.current = k;
    for (const w of cache.current.wheels) w.rotation.x -= rolled / 0.32;
    setOpacity(cache.current.mats, Math.min(1, k / 0.18)); // fades in at the edge of the board
  });

  return (
    <group ref={ref} visible={false} {...(visible ? handlers("wallbox", pointer) : {})}>
      <primitive object={object} />
    </group>
  );
}
