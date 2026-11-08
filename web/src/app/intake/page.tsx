import type { Metadata } from "next";
import { IntakeChat } from "@/components/intake/intake-chat";

export const metadata: Metadata = { title: "Start with questions · Reonic AI Designer" };

/** The typed twin of the voice agent: the same questions as chips, the house builds as you answer, ends in a draft. */
export default function IntakePage() {
  return <IntakeChat />;
}
