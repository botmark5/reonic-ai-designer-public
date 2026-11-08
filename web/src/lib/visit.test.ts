import { describe, expect, it, vi } from "vitest";
import { mockDesign } from "./engine-mock";
import type { SolarResult } from "./solar";
import type { DesignRow } from "./supabase";
import { handleVisit, type VisitDeps } from "./visit";

const SOLAR: SolarResult = {
  status: "ok", address: "Musterstraße 80, München", lat: 48.17, lng: 11.59, max_panels: 30, panel_watts: 450,
  sunshine_hours_year: 1600, imagery_quality: "HIGH", imagery_date: null,
  segments: [{ azimuth_deg: 180, pitch_deg: 35, area_m2: 60 }],
};

function deps(over: Partial<VisitDeps> = {}) {
  const rows: Omit<DesignRow, "id" | "created_at">[] = [];
  const d: VisitDeps = {
    installer: "inst",
    design: vi.fn(async (req) => mockDesign(req)),
    solar: vi.fn(async () => SOLAR),
    createDesign: vi.fn(async (row) => {
      rows.push(row);
      return { ...row, id: "d1", created_at: "2026-11-08T12:00:00Z" } as DesignRow;
    }),
    ...over,
  };
  return { d, rows };
}

describe("handleVisit", () => {
  it("requires the address", async () => {
    const { d } = deps();
    const r = await handleVisit({ facts: { customer_name: "Weber" } }, d);
    expect(r.status).toBe(400);
    expect(d.design).not.toHaveBeenCalled();
  });

  it("normalises the form like a call, adds Google's roof, and stores one form draft", async () => {
    const { d, rows } = deps();
    const r = await handleVisit(
      { facts: { customer_name: "Weber", address: "Musterstraße 80, München", monthly_bill_eur: 140, has_ev: "planned", has_existing_pv: "no", household: 4 } },
      d,
    );
    expect(r.status).toBe(201);
    if (r.status !== 201) return;
    const req = vi.mocked(d.design).mock.calls[0][0];
    expect(req.home.annual_kwh).toBe(4800); // 140 € × 12 / 0.35 €/kWh
    expect(req.home.has_ev).toBe(true);
    expect(req.home.has_existing_pv).toBe(false);
    expect(req.home.roof_max_kwp).toBe(13.5); // 30 panels × 450 W
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "form", status: "draft", customer_name: "Weber", address: "Musterstraße 80, München" });
    expect(r.body).toMatchObject({ design_id: "d1", location: { lat: 48.17, lng: 11.59 } });
  });

  it("keeps the direction the installer chose over Google's face", async () => {
    const { d } = deps();
    await handleVisit({ facts: { address: "A 1, B", roof_direction: "east" } }, d);
    expect(vi.mocked(d.design).mock.calls[0][0].home.roof_azimuth).toBe(90);
  });

  it("designs without roof data when Google has none, and still returns the geocode", async () => {
    const { d } = deps({ solar: async () => ({ status: "not_covered", reason: "x", lat: 1, lng: 2 }) });
    const r = await handleVisit({ facts: { address: "Somewhere 1" } }, d);
    expect(r.status).toBe(201);
    expect(vi.mocked(d.design).mock.calls[0][0].home.roof_max_kwp).toBeUndefined();
    if (r.status === 201) expect(r.body.location).toEqual({ lat: 1, lng: 2 });
  });

  it("falls back to source 'planner' when the database does not know 'form' yet", async () => {
    const createDesign = vi.fn(async (row: Omit<DesignRow, "id" | "created_at">) => {
      if (row.source === "form") throw new Error("violates check constraint");
      return { ...row, id: "d2", created_at: "" } as DesignRow;
    });
    const { d } = deps({ createDesign });
    const r = await handleVisit({ facts: { address: "A 1, B" } }, d);
    expect(r.status).toBe(201);
    expect(createDesign).toHaveBeenLastCalledWith(expect.objectContaining({ source: "planner" }));
  });

  it("reports an unreachable engine without storing anything", async () => {
    const { d, rows } = deps({ design: async () => { throw new Error("down"); } });
    const r = await handleVisit({ facts: { address: "A 1, B" } }, d);
    expect(r.status).toBe(503);
    expect(rows).toHaveLength(0);
  });
});
