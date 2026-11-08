import { describe, expect, it } from "vitest";
import { demoDesign, demoDesignBig, demoHome } from "../mock";
import { getPalette } from "../palette";

describe("house3d fixtures and palette", () => {
  it("demo fixtures come from the mock engine", () => {
    expect(demoHome.has_ev).toBe(true);
    expect(demoDesign.design.pv.kwp).toBe(7.2); // 4,500 kWh + EV 2,700 kWh → 16 modules
    expect(demoDesign.design.wallbox.include).toBe(true);
    expect(demoDesign.design.heatpump.include).toBe(false);
    expect(demoDesignBig.design.pv.kwp).toBe(14.4);
    expect(demoDesignBig.design.heatpump.include).toBe(true);
  });

  it("uses the design-token component colours", () => {
    expect(getPalette("light").pv).toBe("#e9a23b");
    expect(getPalette("light").battery).toBe("#2f9fd0");
    expect(getPalette("dark").battery).toBe("#6cc8ef");
    expect(getPalette("dark").surface0).toBe("#121315");
  });
});
