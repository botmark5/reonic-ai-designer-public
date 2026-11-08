import { mockDesign } from "../../lib/engine-mock";
import { EMPTY_LOCKS, type DesignResponse, type Home } from "../../lib/types";

/** Demo home for previews and tests: 4,500 kWh, EV with 15,000 km a year, gas heating. */
export const demoHome: Home = {
  annual_kwh: 4500,
  price_eur_kwh: 0.32,
  load_profile: "H0",
  has_ev: true,
  ev_km_year: 15000,
  existing_pv_kwp: null,
  existing_battery_kwh: null,
  heating: "Gas",
  heating_demand_kwh: 18000,
  roof_type: "Concrete tile",
  house_sqm: 160,
  inhabitants: 4,
  orientation_deg: 180,
  tilt_deg: 35,
};

/** What the (mock) engine proposes for the demo home. */
export const demoDesign: DesignResponse = mockDesign({ installer: "installer_a", home: demoHome, locks: EMPTY_LOCKS });

/** A large system: 14.4 kWp, 14 kWh, wallbox and a 9 kW heat pump. */
export const demoDesignBig: DesignResponse = mockDesign({
  installer: "installer_a",
  home: demoHome,
  locks: { pv_kwp: 14.4, battery_kwh: 14, wallbox: true, heatpump_kw: 9 },
});
