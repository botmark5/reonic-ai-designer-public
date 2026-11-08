import { describe, expect, it } from "vitest";
import { bandLabel, bandRows, transferRows } from "./deviation";

describe("bandLabel", () => {
  it("reads engine band keys in plain words (upper bound inclusive)", () => {
    expect(bandLabel("0-3000")).toBe("up to 3,000 kWh");
    expect(bandLabel("4500-6000")).toBe("4,500–6,000 kWh");
    expect(bandLabel("9000+")).toBe("over 9,000 kWh");
    expect(bandLabel("not_entered")).toBe("Consumption not entered");
  });
});

describe("bandRows (a-labels #107 shape)", () => {
  const M = (n: number, pvN: number, mae: number | null, bias: number | null, pvAcc = 98) => ({
    n_projects: n, pv_n: pvN, pv_kwp_mae_when_both_pv: mae, pv_kwp_bias_when_both_pv: bias, has_pv_accuracy: pvAcc,
  });
  const byBand = {
    not_entered: { design_model: M(98, 50, 2.54, -0.19, 68), baseline_band_median: { pv_kwp_mae_when_both_pv: 2.97 } },
    "9000+": { design_model: M(15, 15, 3.4, -0.26, 100), baseline_band_median: { pv_kwp_mae_when_both_pv: 3.49 } },
    "0-3000": { design_model: M(54, 53, 2.25, -0.91), baseline_band_median: { pv_kwp_mae_when_both_pv: 2.4 } },
    "6000-9000": { design_model: M(39, 37, 2.61, -1.13), baseline_band_median: { pv_kwp_mae_when_both_pv: 2.82 } },
    "4500-6000": { design_model: M(36, 35, 2.52, 0.03), baseline_band_median: { pv_kwp_mae_when_both_pv: 2.25 } },
    "3000-4500": { design_model: M(4, 3, 9, 0) },
  };
  it("orders by consumption, puts 'not entered' last, counts all homes, skips tiny bands", () => {
    const rows = bandRows(byBand);
    expect(rows.map((r) => r.key)).toEqual(["0-3000", "4500-6000", "6000-9000", "9000+", "not_entered"]);
    expect(rows.map((r) => r.n)).toEqual([54, 36, 39, 15, 98]);
  });
  it("marks the hardest real band, never 'not entered'", () => {
    const rows = bandRows(byBand);
    expect(rows.find((r) => r.hardest)?.key).toBe("9000+");
  });
  it("explains the bias sign in plain words", () => {
    const rows = bandRows(byBand);
    expect(rows[0].sentence).toBe("We size smaller than the experts here, by 0.9 kWp on average.");
    expect(rows[1].sentence).toBe("Close to the experts on average.");
    expect(rows[4].sentence).toBe("Left at the 4,500 kWh default, the engine cannot see the real use: solar yes or no is right in 68 % of these homes.");
  });
  it("is empty without by_band and keeps a band whose bias is null", () => {
    expect(bandRows(undefined)).toEqual([]);
    const r = bandRows({ "0-3000": { design_model: M(20, 0, null, null) } });
    expect(r).toEqual([]); // no home with solar on both sides: no error to show
  });
});

describe("transferRows", () => {
  it("names installers A/B and says whether the engine carries over", () => {
    const rows = transferRows({
      "bbb->aaa": { design_model: { pv_kwp_mae_when_both_pv: 2.8 }, baseline_band_median: { pv_kwp_mae_when_both_pv: 3.2 } },
      "aaa->bbb": { design_model: { pv_kwp_mae_when_both_pv: 3.4 }, baseline_band_median: { pv_kwp_mae_when_both_pv: 3.0 } },
    });
    expect(rows[0]).toMatchObject({ from: "Installer A", to: "Installer B", ours: 3.4, base: 3.0, carries: false });
    expect(rows[1]).toMatchObject({ from: "Installer B", to: "Installer A", carries: true });
    expect(rows[1].sentence).toBe("Learned only on Installer B, it still beats the band median for Installer A.");
    expect(rows[0].sentence).toBe("Learned only on Installer A, it is weaker than the band median for Installer B: each installer has its own habits.");
  });
});

describe("installer letters follow the docs", () => {
  it("A is the installer with the most held-out homes, not the first id alphabetically", async () => {
    const { installerOrder, transferRows } = await import("./deviation");
    const order = installerOrder({ design_model: { "installer_b": { n_projects: 67 }, "installer_a": { n_projects: 248 } } });
    expect(order).toEqual(["installer_a", "installer_b"]);
    const rows = transferRows(
      { "installer_a->installer_b": { design_model: { pv_kwp_mae_when_both_pv: 2.79 }, baseline_band_median: { pv_kwp_mae_when_both_pv: 3.15 } } },
      "design_model",
      "baseline_band_median",
      order,
    );
    expect(rows[0]).toMatchObject({ from: "Installer A", to: "Installer B", ours: 2.79 });
  });
});
