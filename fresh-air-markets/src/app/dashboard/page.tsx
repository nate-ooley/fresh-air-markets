import { redirect } from "next/navigation";
import { getSessionAccountId } from "@/lib/auth";
import { marketWeekends } from "@/lib/market-calendar";
import { getStore, isDemoMode } from "@/lib/store";
import { toPublicAccount } from "@/lib/types";
import AdminDashboard from "@/components/AdminDashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const accountId = await getSessionAccountId();
  if (!accountId) redirect("/login");
  const store = await getStore();
  const account = await store.getAccountById(accountId);
  if (!account) redirect("/login");
  return (
    <AdminDashboard
      weekends={marketWeekends(account.id, process.env, new Date(), true)}
      demoMode={isDemoMode()}
      account={toPublicAccount(account)}
    />
  );
}

