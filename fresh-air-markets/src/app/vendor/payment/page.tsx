import type { Metadata } from "next";
import VendorPaymentPanel from "@/components/VendorPaymentPanel";

export const metadata: Metadata = {
  title: "Your reservation | Fresh Air Markets & Events",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default function VendorPaymentPage() {
  return <VendorPaymentPanel />;
}
