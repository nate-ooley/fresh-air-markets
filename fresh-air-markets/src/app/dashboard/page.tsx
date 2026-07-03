import { redirect } from "next/navigation";
import { getSessionAccountId } from "@/lib/auth";
import { upcomingWeekends } from "@/lib/dates";
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
      weekends={upcomingWeekends()}
      demoMode={isDemoMode()}
      account={toPublicAccount(account)}
    />
  );
}
