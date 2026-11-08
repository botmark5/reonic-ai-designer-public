# Session C: interactive 3D house
Branch: `web/house3d`. Model: Opus. Start AFTER session B pushed milestone 1 (git pull it first).
Read: CLAUDE.md, docs/design/README.md, docs/design/tokens.json, web/src/lib/types.ts.
Skills: superpowers:writing-plans, superpowers:test-driven-development where logic; design-taste-frontend, animate,
improve-animations. Plan first, wait for my OK.

Goal: `<House3D design={DesignResponse} home={Home} mode="planner"|"homeowner" />`, React Three Fiber,
ONLY in web/src/components/house3d/ (+ web/public/models/, web/scripts/house/). First make a tiny PR that only adds
three, @react-three/fiber, @react-three/drei to package.json, so it doesn't clash with session B.

1. House model: one good-looking detached German family house (gable roof, concrete tile, garage). Preferred: a Blender
   Python script (bpy, run headless: `blender -b -P web/scripts/house/build.py`) that exports web/public/models/house.glb.
   If Blender isn't installed, build it procedurally in three.js. Clean, slightly stylised, Reonic palette, soft shadows,
   not photoreal. ≤ 60k triangles.
2. Parametric equipment from the design: panel count = round(pv.kwp / 0.45), laid in rows on the south roof plane with
   margins (roof pitch/direction from home, default 35° south; later capped by Google Solar maxPanels); battery + inverter
   on the garage/utility wall; wallbox by the driveway; heat pump outdoor unit beside the house. Each appears/disappears
   with a short, tasteful animation when toggled.
3. Energy flow: animated lines sun → panels → battery → house → car in the component colours (comp-pv, comp-battery…);
   respect prefers-reduced-motion.
4. Camera: orbit with limits, slow idle rotation, preset views (Roof, Garage). Hover/tap a component → tooltip with
   size and reason. DPR capped at 2, smooth on a phone.
5. A static-image fallback (for slides and slow devices).
Done when it renders inside the planner and /offer/[token] with a mock design. Tick docs/PLAN.md, open a PR.
