import type { Metadata } from "next";
import { VisitPage } from "./visit-page";

export const metadata: Metadata = { title: "Site visit · Reonic AI Designer" };

export default function Page() {
  return <VisitPage />;
}
