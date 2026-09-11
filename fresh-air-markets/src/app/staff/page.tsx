import { redirect } from "next/navigation";
import StaffPanel from "@/components/StaffPanel";
import { getSessionStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Staff directory; the API repeats the session and role checks. */
export default async function StaffPage() {
  const session = await getSessionStaff();
  if (!session) redirect("/login");
  return <StaffPanel />;
}
