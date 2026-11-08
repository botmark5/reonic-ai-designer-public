"use client";
import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";

export type Preset = "street" | "roof" | "garage";
export const PRESETS: readonly Preset[] = ["street", "roof", "garage"];

/** A preset request; `n` changes on every click so re-clicking the active preset resets the view. */
export interface PresetRequest {
  preset: Preset;
  n: number;
}

/** Camera position and target in house coordinates (+z south, +x east / garage side). */
const VIEWS: Record<Preset, { pos: [number, number, number]; target: [number, number, number] }> = {
  street: { pos: [20, 14.2, 31], target: [2.5, 3.7, 3.5] },
  roof: { pos: [3, 21, 24], target: [2, 5, 0.5] },
  garage: { pos: [22, 5.5, 17], target: [8.5, 1.4, 4] },
};
/** Where the fly-in starts: high and wide, the model seen as a whole on its board. */
const FLY_FROM = { pos: [38, 30, 52] as const, target: [1, 0, 2] as const };
const FLY_SMOOTH = 0.42; // camera-controls smoothTime during the fly-in (arrives in ≈ 1.6 s)
const SMOOTH = 0.32;

const { DOLLY, NONE } = CameraControlsImpl.ACTION;

/**
 * Page scroll wins: vertical swipes scroll the page (horizontal ones orbit) and the wheel zooms only with Ctrl/⌘
 * (trackpad pinch sends ctrl+wheel). camera-controls sets touch-action: none on the element it connects to
 * (drei connects it in its own child effect), so this re-applies it once that element exists.
 */
function letPageScroll(c: CameraControlsImpl, done: { el: HTMLElement | null; undo: () => void }) {
  const el = (c as unknown as { _domElement?: HTMLElement })._domElement ?? null;
  if (el && el.style.touchAction !== "pan-y") el.style.touchAction = "pan-y";
  if (el === done.el) return;
  done.undo();
  done.el = el;
  done.undo = () => {};
  if (!el) return;
  const onWheel = (e: WheelEvent) => { c.mouseButtons.wheel = e.ctrlKey || e.metaKey ? DOLLY : NONE; };
  el.addEventListener("wheel", onWheel, { capture: true, passive: true });
  done.undo = () => el.removeEventListener("wheel", onWheel, { capture: true });
}

function look(c: CameraControlsImpl, v: { pos: readonly number[]; target: readonly number[] }, rot: THREE.Matrix4, animate: boolean) {
  const p = new THREE.Vector3(v.pos[0], v.pos[1], v.pos[2]).applyMatrix4(rot);
  const t = new THREE.Vector3(v.target[0], v.target[1], v.target[2]).applyMatrix4(rot);
  return c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, animate);
}

/**
 * Stages with the same sync key share one orbit, in house coordinates (each house may face another way). The one
 * the viewer last touched leads; the others follow without smoothing, so they never echo back.
 */
interface Member { c: CameraControlsImpl; rot: THREE.Matrix4 }
const groups = new Map<string, { members: Set<Member>; leader: Member | null }>();
const S = { p: new THREE.Vector3(), t: new THREE.Vector3(), inv: new THREE.Matrix4() };

function follow(from: Member, to: Member) {
  S.inv.copy(from.rot).invert();
  from.c.getPosition(S.p, false).applyMatrix4(S.inv).applyMatrix4(to.rot);
  from.c.getTarget(S.t, false).applyMatrix4(S.inv).applyMatrix4(to.rot);
  void to.c.setLookAt(S.p.x, S.p.y, S.p.z, S.t.x, S.t.y, S.t.z, false);
}

function useSync(ref: RefObject<CameraControls | null>, key: string | undefined, rotationY: number) {
  const me = useRef<Member | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !key) return;
    const m: Member = { c, rot: new THREE.Matrix4().makeRotationY(rotationY) };
    me.current = m;
    const g = groups.get(key) ?? { members: new Set<Member>(), leader: null };
    groups.set(key, g);
    g.members.add(m);
    const lead = () => { g.leader = m; };
    const update = () => {
      if (g.leader !== m) return;
      for (const o of g.members) if (o !== m) follow(m, o);
    };
    c.addEventListener("controlstart", lead);
    c.addEventListener("update", update);
    return () => {
      c.removeEventListener("controlstart", lead);
      c.removeEventListener("update", update);
      g.members.delete(m);
      if (g.leader === m) g.leader = null;
      if (!g.members.size) groups.delete(key);
      me.current = null;
    };
  }, [ref, key, rotationY]);
  /** A preset click in this stage leads too. */
  return () => {
    const m = me.current;
    const g = key ? groups.get(key) : undefined;
    if (m && g) g.leader = m;
  };
}

/** Zoom to one part: its point in house coordinates and how far the camera stands from it. */
export interface CameraFocus {
  /** Changes when the part or its position changes. */
  key: string;
  target: readonly [number, number, number];
  dist: number;
}

export function CameraRig({ request, rotationY, reduced, flyIn, syncKey, focus = null }: {
  request: PresetRequest; rotationY: number; reduced: boolean; flyIn: boolean; syncKey?: string;
  /** Glide to this part (keeping the viewing angle); back to the preset when it clears. */
  focus?: CameraFocus | null;
}) {
  const ref = useRef<CameraControls>(null);
  const first = useRef(true);
  const flying = useRef(false);
  const lastRot = useRef(rotationY);
  const reducedRef = useRef(reduced);
  const scrollSetup = useRef<{ el: HTMLElement | null; undo: () => void }>({ el: null, undo: () => {} });
  const lead = useSync(ref, syncKey, rotationY);

  useEffect(() => { reducedRef.current = reduced; }, [reduced]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const rot = new THREE.Matrix4().makeRotationY(rotationY);
    const turned = lastRot.current !== rotationY;
    lastRot.current = rotationY;
    if (!first.current && flying.current && turned) {
      // the roof arrived (e.g. from /api/solar) during the fly-in: keep gliding, just to the turned street view
      void look(c, VIEWS.street, rot, true).then(() => { flying.current = false; c.smoothTime = SMOOTH; });
    } else if (first.current && flyIn && !reducedRef.current) {
      // fly-in: start high and wide, glide to the street view; any input or key skips it
      void look(c, FLY_FROM, rot, false);
      c.smoothTime = FLY_SMOOTH;
      flying.current = true;
      void look(c, VIEWS.street, rot, true).then(() => { flying.current = false; c.smoothTime = SMOOTH; });
    } else {
      if (!first.current) lead();
      flying.current = false;
      c.smoothTime = SMOOTH;
      void look(c, VIEWS[request.preset], rot, !reducedRef.current && !first.current);
    }
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lead only marks this stage as the leader
  }, [request, rotationY, flyIn]);

  // click to focus: glide to the part from the current viewing angle; let go: back to the active preset
  const focused = useRef(false);
  const focusRef = useRef(focus);
  useEffect(() => { focusRef.current = focus; });
  const presetRef = useRef(request);
  useEffect(() => { presetRef.current = request; }, [request]);
  const focusKey = focus?.key ?? null;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const rot = new THREE.Matrix4().makeRotationY(rotationY);
    const f = focusRef.current;
    if (f) {
      lead();
      flying.current = false;
      c.smoothTime = SMOOTH;
      const t = new THREE.Vector3(f.target[0], f.target[1], f.target[2]).applyMatrix4(rot);
      const dir = c.getPosition(new THREE.Vector3(), true).sub(c.getTarget(new THREE.Vector3(), true)).normalize();
      if (dir.y < 0.3) { dir.y = 0.3; dir.normalize(); } // never from below or flat on the ground
      const p = t.clone().addScaledVector(dir, f.dist);
      void c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, !reducedRef.current);
      focused.current = true;
    } else if (focused.current) {
      focused.current = false;
      lead();
      void look(c, VIEWS[presetRef.current.preset], rot, !reducedRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-aim only when the focused part changes
  }, [focusKey]);

  // skip the fly-in on any key; a drag or pinch takes over the camera by itself
  useEffect(() => {
    const skip = (e: KeyboardEvent) => {
      const c = ref.current;
      if (!c || !flying.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // typing elsewhere
      flying.current = false;
      c.smoothTime = SMOOTH;
      void look(c, VIEWS.street, new THREE.Matrix4().makeRotationY(rotationY), false);
    };
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [rotationY]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const stopFlying = () => { if (flying.current) { flying.current = false; c.smoothTime = SMOOTH; } };
    c.addEventListener("controlstart", stopFlying);
    const scroll = scrollSetup.current;
    return () => {
      scroll.undo();
      c.removeEventListener("controlstart", stopFlying);
    };
  }, []);

  useFrame(() => {
    const c = ref.current;
    if (c) letPageScroll(c, scrollSetup.current); // cheap; camera-controls (re)connects after our effects
  });

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minDistance={12}
      maxDistance={60}
      minPolarAngle={0.25}
      maxPolarAngle={1.36}
      truckSpeed={0}
      smoothTime={SMOOTH}
      draggingSmoothTime={0.12}
    />
  );
}
