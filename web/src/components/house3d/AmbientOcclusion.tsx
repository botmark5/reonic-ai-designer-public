"use client";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

/** GTAO computed at half resolution (the blend samples it up): soft model-like occlusion at a fraction of the cost. */
class HalfResGTAOPass extends GTAOPass {
  setSize(width: number, height: number) {
    super.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
  }
}

function setBlend(pass: GTAOPass, intensity: number) {
  pass.blendIntensity = intensity;
}

/**
 * Ambient occlusion with three's own GTAOPass (kept in step with three), then OutputPass for tone mapping and colour
 * space. Takes over rendering while mounted (useFrame priority 1); unmount it to fall back to the plain render.
 */
export function AmbientOcclusion({ intensity = 1 }: { intensity?: number }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);

  const { composer, ao } = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(gl, target);
    composer.renderTarget2.samples = 0; // ping-pong target after the scene pass: no MSAA needed (saves ~half the memory)
    composer.addPass(new RenderPass(scene, camera));
    const ao = new HalfResGTAOPass(scene, camera, 2, 2);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 12, distanceFallOff: 1 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    composer.addPass(ao);
    composer.addPass(new OutputPass());
    return { composer, ao };
  }, [gl, scene, camera]);

  useEffect(() => setBlend(ao, intensity), [ao, intensity]);

  useEffect(() => {
    composer.setPixelRatio(dpr);
    composer.setSize(size.width, size.height);
  }, [composer, size.width, size.height, dpr]);

  useEffect(() => () => {
    composer.dispose();
    for (const p of composer.passes) (p as { dispose?: () => void }).dispose?.();
  }, [composer]);

  useFrame((_, dt) => {
    composer.render(dt);
  }, 1);

  return null;
}
