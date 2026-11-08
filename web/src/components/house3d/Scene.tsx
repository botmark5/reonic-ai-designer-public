"use client";
import { ContactShadows, Environment, Html, Lightformer, PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, type RootState } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { AmbientOcclusion } from "./AmbientOcclusion";
import { CameraRig, type PresetRequest } from "./CameraRig";
import type { DayStep, FlowNodeId, LiveFlow } from "./energyDay";
import { EnergyFlow } from "./EnergyFlow";
import { Appear, Battery, Car, Layer, Panels, WarmWindows, type PanelEditing, type Pointer } from "./Equipment";
import { batteryModuleCount, buildEquipment } from "./equipmentGeometry";
import { buildHouse, slotToWorld, type Mount } from "./houseGeometry";
import type { Palette } from "./palette";
import type { CompKey, SceneSpec } from "./sceneSpec";
import { sunDirection, sunLight } from "./sun";
import type { Shown } from "./stage";
import { Label, Tooltip } from "./Tooltip";
import type { PanelSlot } from "./layout";

export interface SceneProps {
  spec: SceneSpec;
  palette: Palette;
  dark: boolean;
  reduced: boolean;
  preset: PresetRequest;
  active: CompKey | null;
  pointer: Pointer;
  /** The modelled moment of the day (sun, flows, battery %). */
  moment: DayStep;
  flows: LiveFlow[];
  batteryKwh: number | null;
  flyIn: boolean;
  /** What is on stage during a /live build-up (everything otherwise). */
  shown: Shown;
  /** A build-up is running: the heat pump stands as a ghost first. */
  building: boolean;
  /** The design offers a heat pump without including it: shown as a ghost when revealed. */
  hpOption: boolean;
  /** Its size, for the "option" label. */
  hpOptionKw?: number | null;
  /** Always-on labels (PV kWp, battery kWh...) for a projector. */
  labels: boolean;
  /** Stages with the same key share one orbit. */
  cameraKey?: string;
  /** Planner panel editing (null: off). */
  panelEdit?: PanelEditing | null;
  /** The part the camera zooms to (click to focus); null: the preset view. */
  focus?: CompKey | null;
  /** Draw the energy flow lines and sun rays (default true). */
  flowsOn?: boolean;
  /** false while the canvas is scrolled out of view: the render loop pauses. */
  inView: boolean;
  onMiss: () => void;
  onReady: (state: RootState) => void;
}

/**
 * Quality tiers: 2 = AO + DPR 2, 1 = no AO + DPR 1.5, 0 = DPR 1. Monitoring starts after load (shader compiles would
 * otherwise read as a slow device), can step back up, and settles at tier 1 if it keeps flip-flopping.
 * Measured on an Apple M5 in a real Chrome window at DPR 2 with AO, while the day plays: 60 fps, p95 frame 18 ms.
 */
type Tier = 0 | 1 | 2;

function dispose(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
  });
}

const NO_SLOTS: PanelSlot[] = [];
const num = (x: number) => String(Number(x.toFixed(2)));
const LABEL_SIDE = { pv: "above", battery: "right", wallbox: "left", heatpump: "left" } as const;
const facing = (m: Mount) => new THREE.Vector3(Math.sin(m.yaw), 0, Math.cos(m.yaw));
const UP = new THREE.Vector3(0, 1, 0);
const SUN_TARGET = new THREE.Vector3(); // per-frame scratch
const WARM_SKY = new THREE.Color("#ffd2a6");
const NIGHT_SKY = new THREE.Color("#b9c3d6");
const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Sun light, sky fill and environment strength follow the time of day. The sun stays put in the world. */
function Daylight({ moment, palette, reduced }: { moment: DayStep; palette: Palette; reduced: boolean }) {
  const sun = useRef<THREE.DirectionalLight>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const now = useRef<{ dir: THREE.Vector3; elev: number } | null>(null);
  useFrame((state, dt) => {
    const target = SUN_TARGET;
    const l = sun.current;
    if (!l) return;
    // ease towards the moment (smooths slider jumps and the ~15 Hz updates while the day plays)
    sunDirection(moment.sun, target);
    if (!now.current) now.current = { dir: target.clone(), elev: moment.sun.elevationDeg };
    const k = reduced ? 1 : 1 - Math.exp(-10 * Math.min(dt, 0.1));
    now.current.dir.lerp(target, k).normalize();
    now.current.elev += (moment.sun.elevationDeg - now.current.elev) * k;
    const elev = now.current.elev;
    const { color, intensity } = sunLight(elev);
    l.position.copy(now.current.dir).multiplyScalar(45).add(l.target.position);
    l.color.copy(color);
    l.intensity = intensity;
    const day = Math.min(1, Math.max(0, (elev + 4) / 14));
    if (hemi.current) {
      // golden hour warms the whole sky fill (the low sun itself often lights faces we don't see); night cools it
      const warm = (1 - smooth01(4, 24, elev)) * smooth01(-3, 3, elev) * 0.75;
      const night = 1 - smooth01(-6, 1, elev);
      hemi.current.color.set(palette.sky).lerp(WARM_SKY, warm).lerp(NIGHT_SKY, night);
      hemi.current.intensity = 0.3 + 0.5 * day;
    }
    (state.scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = 0.35 + 0.5 * day;
  });
  return (
    <>
      <hemisphereLight ref={hemi} args={[palette.sky, palette.groundBounce, 0.7]} />
      <directionalLight
        ref={sun}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-camera-near={1}
        shadow-camera-far={110}
        shadow-bias={-0.0003}
        shadow-normalBias={0.035}
        shadow-radius={3}
      />
    </>
  );
}

/** The sun's shadow map is drawn once per frame, not once per render call (contact shadows and AO render too). */
function ShadowsOncePerFrame() {
  useFrame((state) => { state.gl.shadowMap.needsUpdate = true; }, -1);
  return null;
}

/** Vertical field of view in landscape. Narrower than 5:4 (portrait phones, 4:5 slides), widen it so the model keeps its width. */
const FOV = 30;
const FIT_ASPECT = 1.1;
const TAN_H = Math.tan(((FOV / 2) * Math.PI) / 180) * FIT_ASPECT;
function FitWidth() {
  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    const aspect = state.size.width / Math.max(1, state.size.height);
    const fov = aspect >= FIT_ASPECT ? FOV : (2 * Math.atan(TAN_H / aspect) * 180) / Math.PI;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }, -1);
  return null;
}

/** Exposure follows the theme (the renderer outlives theme switches). */
function Exposure({ dark }: { dark: boolean }) {
  useFrame((state) => { state.gl.toneMappingExposure = dark ? 0.95 : 1.02; }, -1);
  return null;
}

function World({ spec, palette, reduced, preset, active, pointer, moment, flows, batteryKwh, flyIn, shown, building, hpOption, hpOptionKw, labels: showLabels, cameraKey, panelEdit, focus = null, flowsOn = true }: Omit<SceneProps, "onMiss" | "onReady" | "dark" | "inView">) {
  const rotationY = THREE.MathUtils.degToRad(180 - spec.roof.azimuthDeg);
  const house = useMemo(() => buildHouse(spec.roof.pitchDeg, palette), [spec.roof.pitchDeg, palette]);
  const equipment = useMemo(() => buildEquipment(palette), [palette]);
  useEffect(() => () => { for (const part of Object.values(house.parts)) dispose(part); }, [house]);
  useEffect(() => () => Object.values(equipment).forEach(dispose), [equipment]);

  const { anchors, frames } = house;
  const c = spec.components;

  // Points in house coordinates for flows and tooltips
  const { nodes, rays, labels } = useMemo(() => {
    const main = spec.layout.slots.filter((s) => s.plane === "main");
    const centre = main.length
      ? main.reduce((acc, s) => acc.add(slotToWorld(frames.main, s.u, s.v, 0.3)), new THREE.Vector3()).divideScalar(main.length)
      : slotToWorld(frames.main, 0, frames.main.plane.slope / 2, 0.3);
    const us = main.map((s) => s.u);
    const vMid = main.length ? main.reduce((a, s) => a + s.v, 0) / main.length : 0;
    const rays = main.length
      ? [Math.min(...us) * 0.7, 0, Math.max(...us) * 0.7].map((u) => slotToWorld(frames.main, u, vMid, 0.25))
      : [];
    const at = (m: Mount, up: number, out: number) => m.position.clone().addScaledVector(facing(m), out).add(new THREE.Vector3(0, up, 0));
    const nodes: Record<FlowNodeId, THREE.Vector3> = {
      sun: centre.clone().add(new THREE.Vector3(0, 8, 0)),
      panels: centre,
      inverter: at(anchors.inverter, 0.3, 0.25),
      battery: at(anchors.battery, 0.8, 0.35),
      house: anchors.house.clone().add(new THREE.Vector3(0, 0, 0.2)),
      wallbox: at(anchors.wallbox, 0.2, 0.2),
      car: anchors.car.position.clone().add(new THREE.Vector3(0, 0.95, -1.7)),
      grid: anchors.grid.position.clone().add(new THREE.Vector3(0, 0.3, 0)),
      heatpump: at(anchors.heatpump, 0.9, 0.35),
    };
    const labels: Record<CompKey, THREE.Vector3> = {
      pv: centre.clone().addScaledVector(frames.main.normal, 1.2),
      inverter: at(anchors.inverter, 1.0, 0.3),
      battery: at(anchors.battery, 2.2, 0.3),
      wallbox: at(anchors.wallbox, 0.8, 0.3),
      heatpump: at(anchors.heatpump, 1.4, 0.3),
    };
    return { nodes, rays, labels };
  }, [spec.layout.slots, frames, anchors]);
  // click to focus: the part's centre and a camera distance that frames it (the car comes with the wallbox)
  const cameraFocus = useMemo(() => {
    if (!focus) return null;
    // aim between the part and its info card, so both stay in frame
    const mid = (k: CompKey, at: THREE.Vector3) => at.clone().lerp(labels[k], 0.5);
    const at: Record<CompKey, [THREE.Vector3, number]> = {
      pv: [mid("pv", nodes.panels), 17],
      inverter: [mid("inverter", nodes.inverter), 8.5],
      battery: [mid("battery", nodes.battery), 9.5],
      wallbox: [mid("wallbox", nodes.wallbox).lerp(nodes.car, 0.3), 12],
      heatpump: [mid("heatpump", nodes.heatpump), 9.5],
    };
    const [p, dist] = at[focus];
    const target = [p.x, p.y, p.z] as const;
    return { key: `${focus}:${target.map((x) => x.toFixed(1)).join(",")}`, target, dist };
  }, [focus, nodes, labels]);

  // the sun stays put in the world; express its direction in house coordinates (for the rays)
  const sunLocal = useMemo(() => sunDirection(moment.sun).applyAxisAngle(UP, -rotationY), [moment.sun, rotationY]);

  // heat pump fan turns with its load
  const fan = useMemo(() => equipment.heatpump.getObjectByName("fan") ?? null, [equipment]);
  const hpLoad = useRef(0);
  useEffect(() => { hpLoad.current = moment.heatpump; }, [moment.heatpump]);
  useFrame((_, dt) => {
    if (fan && !reduced && c.heatpump.visible && shown.heatpump) spinFan(fan, dt * (1.5 + hpLoad.current * 9));
  });

  const activeSpec = active ? c[active] : null;
  // drei's Html labels mounted in the very first commit can lose their root; mount them a frame later
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  const modules = c.battery.visible && shown.battery ? batteryModuleCount(batteryKwh) : 0;
  const slots = useMemo(() => {
    const all = spec.layout.slots;
    if (shown.panels && shown.existingPv) return all;
    if (!shown.panels && !shown.existingPv) return NO_SLOTS;
    return shown.existingPv ? all.slice(0, spec.existingPanels) : all.slice(spec.existingPanels);
  }, [spec.layout.slots, spec.existingPanels, shown.panels, shown.existingPv]);
  const intro = flyIn && !reduced; // first appearance animates only with the fly-in
  // contact shadows re-render only for a few seconds after something on the ground changed
  const groundKey = `${slots.length}|${modules}|${c.wallbox.visible && shown.car}|${c.heatpump.visible && shown.heatpump}|${shown.shell}|${spec.roof.pitchDeg}|${palette.surface0}`;
  // always-on labels sit on the part itself and to its side (the tooltip keeps the spot above)
  const labelAt = useMemo(() => ({
    pv: nodes.panels.clone().addScaledVector(frames.main.normal, 0.3),
    battery: labels.battery.clone().add(new THREE.Vector3(0, -1.0, 0)),
    wallbox: labels.wallbox.clone(),
    heatpump: labels.heatpump.clone(),
  }), [nodes, labels, frames]);
  const labelKeys = (["pv", "battery", "wallbox", "heatpump"] as const).filter((k) =>
    showLabels && settled && c[k].visible && k !== active && (k === "pv" ? shown.pv && !panelEdit?.selected : k === "battery" ? shown.battery : k === "wallbox" ? shown.car : shown.heatpump));

  return (
    <>
      <group rotation-y={rotationY}>
        <primitive object={house.parts.site} />
        <Layer object={house.parts.shell} shown={shown.shell} kind="rise" reduced={reduced} />
        <WarmWindows glass={house.glass} on={shown.warm} reduced={reduced} />
        <Layer object={house.parts.roof} shown={shown.roof} kind="settle" reduced={reduced} />
        <Panels slots={slots} frames={frames} palette={palette} reduced={reduced} intro={intro} pointer={pointer} edit={panelEdit} />
        <Appear object={equipment.inverter} mount={anchors.inverter} visible={c.inverter.visible && shown.inverter} reduced={reduced} intro={intro} delay={0.05} hitKey="inverter" pointer={pointer} />
        <Appear object={equipment.wallbox} mount={anchors.wallbox} visible={c.wallbox.visible && shown.car} reduced={reduced} intro={intro} delay={0.05} hitKey="wallbox" pointer={pointer} />
        <Appear object={equipment.heatpump} mount={anchors.heatpump} visible={(c.heatpump.visible || hpOption) && shown.heatpump} reduced={reduced} intro={intro} delay={0.05} ghostFor={building ? 0.9 : 0} ghostOnly={!c.heatpump.visible} hitKey="heatpump" pointer={pointer} />
        <Battery mount={anchors.battery} modules={modules} soc={moment.soc} palette={palette} reduced={reduced} intro={intro} pointer={pointer} />
        <Car object={equipment.car} path={anchors.carPath} visible={c.wallbox.visible && shown.car} reduced={reduced} intro={intro} pointer={pointer} />
        {/* the flows step aside while a panel is picked or dragged (they would draw over it) */}
        <group visible={flowsOn && !panelEdit?.selected}>
          <EnergyFlow flows={flows} nodes={nodes} sunDir={sunLocal} rayTargets={rays} gradientStops={palette.flow} reduced={reduced} />
        </group>
        <ContactShadows key={groundKey} frames={reduced ? 2 : 200} position={[1.2, 0.012, 2]} scale={38} resolution={512} blur={2.6} far={7} opacity={0.38} color="#1b1d20" />
        {/* drei's first Html in a canvas can lose its root under React 19: a placeholder takes that hit */}
        {settled && <Html position={[0, -50, 0]} style={{ display: "none" }}><span /></Html>}
        {labelKeys.map((k) => <Label key={k} spec={c[k]} position={labelAt[k]} side={LABEL_SIDE[k]} />)}
        {showLabels && settled && hpOption && !c.heatpump.visible && shown.heatpump && hpOptionKw && (
          <Label spec={{ ...c.heatpump, title: "Heat pump", size: `option ${num(hpOptionKw)} kW` }} position={labelAt.heatpump} side="left" />
        )}
        {activeSpec?.visible && <Tooltip spec={activeSpec} position={labels[activeSpec.key]} />}
      </group>
      <Daylight moment={moment} palette={palette} reduced={reduced} />
      <FitWidth />
      <CameraRig request={preset} rotationY={rotationY} reduced={reduced} flyIn={flyIn} syncKey={cameraKey} focus={cameraFocus} />
    </>
  );
}

function spinFan(fan: THREE.Object3D, by: number) {
  fan.rotation.z -= by;
}

/** Soft studio reflections without network: a few light cards rendered into the environment map once. */
function Studio() {
  return (
    <Environment resolution={128} frames={1}>
      <Lightformer form="rect" intensity={1.6} position={[0, 12, 0]} rotation-x={Math.PI / 2} scale={[30, 30, 1]} color="#ffffff" />
      <Lightformer form="rect" intensity={1.1} position={[-16, 6, 14]} target={[0, 0, 0]} scale={[16, 8, 1]} color="#ffe2bf" />
      <Lightformer form="rect" intensity={0.5} position={[16, 4, -10]} target={[0, 0, 0]} scale={[14, 6, 1]} color="#e8eef8" />
      <Lightformer form="circle" intensity={2.4} position={[-10, 14, 22]} target={[0, 0, 0]} scale={4} color="#fff3e2" />
    </Environment>
  );
}

/** The R3F canvas. Client-only: load it through next/dynamic with ssr: false (see House3D). */
export default function Scene({ onMiss, onReady, dark, inView, ...props }: SceneProps) {
  const [tier, setTier] = useState<Tier>(2);
  const [monitor, setMonitor] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setMonitor(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Canvas
      shadows
      frameloop={inView ? "always" : "never"}
      dpr={[1, tier === 2 ? 2 : tier === 1 ? 1.5 : 1]}
      camera={{ fov: FOV, near: 0.5, far: 260, position: [19, 10.5, 30] }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      onPointerMissed={onMiss}
      onCreated={(state) => {
        state.gl.toneMapping = THREE.NeutralToneMapping;
        state.gl.shadowMap.autoUpdate = false; // see ShadowsOncePerFrame
        onReady(state);
      }}
      style={{ touchAction: "pan-y" }}
    >
      {monitor && (
        <PerformanceMonitor
          flipflops={3}
          onDecline={() => setTier((t) => (t > 0 ? ((t - 1) as Tier) : 0))}
          onIncline={() => setTier((t) => (t < 2 ? ((t + 1) as Tier) : 2))}
          onFallback={() => setTier(1)}
        />
      )}
      <ShadowsOncePerFrame />
      <Exposure dark={dark} />
      <Studio />
      <World {...props} />
      {tier === 2 && <AmbientOcclusion intensity={dark ? 0.85 : 1} />}
    </Canvas>
  );
}
