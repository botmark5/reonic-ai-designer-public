/**
 * Low-poly equipment. Each group's origin is the back-bottom-centre of the item (against its wall or on the ground)
 * and it faces local +z. Housings are model white; colour only marks the system (component tokens).
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Palette } from "./palette";

export type EquipmentKey = "inverter" | "wallbox" | "heatpump" | "car";

const std = (color: string, roughness = 0.6, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

function part(g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function rounded(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 4 });
  geo.translate(0, 0, -d / 2);
  return geo;
}

function inverter(p: Palette) {
  const g = new THREE.Group();
  part(g, rounded(0.5, 0.62, 0.18, 0.04), std(p.appliance, 0.7), 0, 0.31, 0.09);
  part(g, new THREE.BoxGeometry(0.2, 0.08, 0.01), std(p.ink, 0.3), 0, 0.44, 0.185);
  part(g, new THREE.BoxGeometry(0.3, 0.018, 0.01), std(p.pv, 0.4), 0, 0.14, 0.185);
  return g;
}

function wallbox(p: Palette) {
  const g = new THREE.Group();
  part(g, rounded(0.3, 0.42, 0.13, 0.05), std(p.wallbox, 0.45), 0, 0.21, 0.065);
  part(g, new THREE.CircleGeometry(0.04, 20), std(p.surface1, 0.3), 0, 0.3, 0.131);
  const cable = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.02, 0.1),
    new THREE.Vector3(0.05, -0.35, 0.18),
    new THREE.Vector3(0.22, -0.55, 0.12),
    new THREE.Vector3(0.28, -0.2, 0.05),
  ]);
  part(g, new THREE.TubeGeometry(cable, 20, 0.016, 6), std(p.wallbox, 0.6), 0, 0, 0);
  return g;
}

/** Heat pump outdoor unit; the fan is the child named "fan" (spins about local z). */
function heatpump(p: Palette) {
  const g = new THREE.Group();
  part(g, new THREE.BoxGeometry(1.2, 0.08, 0.55), std(p.plinth, 0.95), 0, 0.04, 0.3);
  part(g, rounded(1.05, 0.78, 0.4, 0.05), std(p.appliance, 0.7), 0, 0.49, 0.3);
  const front = 0.5 + 0.002;
  part(g, new THREE.CircleGeometry(0.27, 32), std(p.ink, 0.95), -0.16, 0.5, front);
  const ring = part(g, new THREE.TorusGeometry(0.28, 0.022, 8, 40), std(p.heatpump, 0.45), -0.16, 0.5, front);
  ring.castShadow = false;
  const fan = new THREE.Group();
  fan.name = "fan";
  fan.position.set(-0.16, 0.5, front + 0.004);
  const blade = std(p.inkMuted, 0.6);
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.008), blade);
    b.position.set(Math.cos(a) * 0.11, Math.sin(a) * 0.11, 0);
    b.rotation.z = a;
    fan.add(b);
  }
  g.add(fan);
  part(g, new THREE.BoxGeometry(0.16, 0.46, 0.008), std(p.border, 0.8), 0.32, 0.5, front);
  return g;
}

/** A white model hatchback from rounded boxes. Origin between the axles on the ground, nose towards local -z.
 *  Wheels are named "wheel". */
function car(p: Palette) {
  const g = new THREE.Group();
  const body = std(p.car, 0.7);
  part(g, new RoundedBoxGeometry(1.78, 0.58, 4.15, 3, 0.2), body, 0, 0.6, 0);
  // glasshouse: side profile with a raked windscreen and hatch, extruded across the width
  const c = new THREE.Shape(); // shape x = length (front at +x), y = height above the body
  c.moveTo(1.05, 0);
  c.lineTo(0.35, 0.5);
  c.lineTo(-1.05, 0.5);
  c.lineTo(-1.35, 0);
  c.closePath();
  const cabin = new THREE.ExtrudeGeometry(c, { depth: 1.5, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 });
  cabin.rotateY(Math.PI / 2); // shape x → world -z (nose at local -z)
  cabin.translate(-0.75, 0.86, 0.15);
  part(g, cabin, std(p.carGlass, 0.3), 0, 0, 0);
  part(g, new RoundedBoxGeometry(1.5, 0.06, 1.42, 2, 0.03), body, 0, 1.38, 0.5);
  const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 24);
  wheel.rotateZ(Math.PI / 2);
  const tyre = std(p.tyre, 0.85);
  for (const x of [-0.8, 0.8])
    for (const z of [-1.32, 1.32]) {
      const w = part(g, wheel, tyre, x, 0.33, z);
      w.name = "wheel";
    }
  return g;
}

export function buildEquipment(p: Palette): Record<EquipmentKey, THREE.Group> {
  return { inverter: inverter(p), wallbox: wallbox(p), heatpump: heatpump(p), car: car(p) };
}

/** One battery module (≈ 2.5 kWh): white housing with a thin battery-blue seam. Origin bottom-centre-back. */
export const BATTERY_MODULE = { w: 0.62, h: 0.3, d: 0.24, kwh: 2.5 } as const;
export const MAX_BATTERY_MODULES = 8;

export function batteryModuleCount(kwh: number | null | undefined): number {
  if (kwh == null || !Number.isFinite(kwh) || kwh <= 0) return 0;
  return Math.min(MAX_BATTERY_MODULES, Math.max(1, Math.round(kwh / BATTERY_MODULE.kwh)));
}

export function buildBatteryParts(p: Palette) {
  const { w, h, d } = BATTERY_MODULE;
  return {
    module: rounded(w, h - 0.012, d, 0.03),
    seam: new THREE.BoxGeometry(w - 0.06, 0.01, 0.006),
    base: new THREE.BoxGeometry(w + 0.04, 0.08, d + 0.04),
    housing: std(p.appliance, 0.7),
    accent: std(p.battery, 0.4),
    plinth: std(p.plinth, 0.9),
    /** Fill gauge on the side of the stack, scaled in y by state of charge. */
    gauge: new THREE.BoxGeometry(0.035, 1, 0.012),
    gaugeTrack: std(p.border, 0.9),
  };
}
