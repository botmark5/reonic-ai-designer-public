export type RenderMode = "3d" | "static";

export interface RenderEnv {
  webgl: boolean;
  saveData?: boolean;
  /** navigator.hardwareConcurrency */
  cores?: number;
  forceStatic?: boolean;
}

/** Static image when WebGL is missing, data saver is on, the device is very weak, or the caller asks for it. */
export function chooseRenderMode(env: RenderEnv): RenderMode {
  if (env.forceStatic || !env.webgl || env.saveData) return "static";
  if (env.cores != null && env.cores <= 2) return "static";
  return "3d";
}

let cached: RenderEnv | null = null;

/** Browser-only. Probes WebGL once per page. */
export function detectEnv(): RenderEnv {
  if (cached) return cached;
  let webgl = false;
  try {
    const c = document.createElement("canvas");
    const ctx = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    webgl = !!ctx;
    ctx?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl = false;
  }
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  cached = { webgl, saveData: nav.connection?.saveData, cores: nav.hardwareConcurrency };
  return cached;
}
