import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { OfferView } from "@/components/homeowner/offer-view";
import { getOffer } from "@/lib/offer";

export const metadata: Metadata = { title: "Your energy system · Reonic", robots: { index: false } };

export default function OfferPage({ params }: PageProps<"/offer/[token]">) {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-xl flex-1 px-4 py-10" aria-busy="true" />}>
      <Offer params={params} />
    </Suspense>
  );
}

async function Offer({ params }: { params: PageProps<"/offer/[token]">["params"] }) {
  await connection();
  const { token } = await params;
  const offer = await getOffer(token);
  if (!offer) notFound();
  return <OfferView offer={offer} />;
}
