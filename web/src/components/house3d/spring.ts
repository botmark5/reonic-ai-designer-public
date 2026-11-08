/**
 * A tiny spring integrator for per-frame three.js animation (no React state). Configured the Apple way:
 * `response` (seconds, how quickly it gets there) and `dampingRatio` (1 = no overshoot, < 1 = a little bounce).
 * Springs start from the current value and keep their velocity when the target changes, so they are interruptible.
 */

export interface SpringState {
  x: number;
  v: number;
}

export interface SpringConfig {
  stiffness: number;
  damping: number;
}

export function spring(response: number, dampingRatio = 1): SpringConfig {
  const w = (2 * Math.PI) / response;
  return { stiffness: w * w, damping: 2 * dampingRatio * w };
}

/** Critically damped, for things that settle (battery fill, components, camera-free UI). */
export const SETTLE = spring(0.45, 1);
/** Slight bounce, only for things that land (panels dropping onto the roof). */
export const LAND = spring(0.42, 0.78);
/** Slower, for the car rolling in. */
export const ROLL = spring(1.1, 1);

const MAX_STEP = 1 / 240;

/** Advance in place by dt seconds (sub-stepped, stable for long frames). Returns true while still moving. */
export function stepSpring(s: SpringState, target: number, dt: number, c: SpringConfig): boolean {
  let left = Math.min(dt, 0.1);
  while (left > 0) {
    const h = Math.min(MAX_STEP, left);
    const a = -c.stiffness * (s.x - target) - c.damping * s.v;
    s.v += a * h;
    s.x += s.v * h;
    left -= h;
  }
  if (Math.abs(s.x - target) < 1e-4 && Math.abs(s.v) < 1e-3) {
    s.x = target;
    s.v = 0;
    return false;
  }
  return true;
}
