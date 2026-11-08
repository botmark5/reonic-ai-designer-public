import { connection } from "next/server";
import { EXAMPLE_DESIGN_REQUEST, engine, engineHealth, engineKey } from "@/lib/engine";

/**
 * GET /api/engine/health: quick end-to-end check. Calls engine /health (no key) and one /design with the
 * docs/api.md example home through the same client the app uses. Reports who answered; never exposes the key.
 */
export async function GET() {
  await connection();
  const health = await engineHealth();
  const r = await engine.design(EXAMPLE_DESIGN_REQUEST);
  const d = r.design;
  return Response.json({
    engine: { url_configured: Boolean(health.url), key_configured: Boolean(engineKey()), ...health, url: undefined },
    design_check: {
      served: r.served,
      model_version: r.model_version,
      home: "4,500 kWh, 0.32 €/kWh, no EV, gas",
      pv_kwp: d.pv.include ? d.pv.kwp : null,
      battery_kwh: d.battery.include ? d.battery.kwh : null,
      wallbox: d.wallbox.include,
      heatpump_kw: d.heatpump.include ? d.heatpump.kw : null,
      heatpump_option: r.options?.heatpump?.available ? r.options.heatpump.kw : null,
      autarky: r.physics.autarky,
      similar_homes: r.similar_homes.length,
    },
  });
}
