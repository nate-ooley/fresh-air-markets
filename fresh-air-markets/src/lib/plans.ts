import { randomBytes } from "crypto";
import { Plan } from "./types";

export const TRIAL_DAYS = 14;

export interface PlanInfo {
  id: Plan;
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  features: string[];
  highlight?: boolean;
}

export const PLANS: PlanInfo[] = [
  {
    id: "starter",
    name: "Starter",
    price: "$29",
    cadence: "/month",
    tagline: "For weekend markets getting organized",
    features: [
      "Interactive booth map (up to 40 booths)",
      "Vendor inquiry forms & approvals",
      "One-vendor-per-booth enforcement",
      "Drag-and-drop map editor",
      "Variable per-booth pricing",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$79",
    cadence: "/month",
    tagline: "For markets that run like a business",
    highlight: true,
    features: [
      "Everything in Starter, unlimited booths",
      "GoHighLevel marketing automation",
      "Multi-weekend & seasonal bookings",
      "Occupancy & revenue dashboard",
      "Priority email support",
    ],
  },
  {
    id: "season",
    name: "Season Pass",
    price: "$790",
    cadence: "/year",
    tagline: "A full season, two months free",
    features: [
      "Everything in Pro, billed yearly",
      "Season-long vendor licenses",
      "White-glove onboarding",
      "Custom map built for your grounds",
      "Phone support on market days",
    ],
  },
];

export function isPlan(value: string): value is Plan {
  return PLANS.some((p) => p.id === value);
}

/** License keys look like FAM-7F2A-9C41-D08B. */
export function generateLicenseKey(): string {
  const chunk = () => randomBytes(2).toString("hex").toUpperCase();
  return `FAM-${chunk()}-${chunk()}-${chunk()}`;
}

export function trialEndsAt(from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d.toISOString();
}

export function trialDaysLeft(trialEndsAtIso: string): number {
  return Math.max(0, Math.ceil((new Date(trialEndsAtIso).getTime() - Date.now()) / 86_400_000));
}
