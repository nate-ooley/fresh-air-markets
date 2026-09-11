import { redirect } from "next/navigation";
import RosterPanel from "@/components/RosterPanel";
import { getSessionAccountId } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Staff-only roster; the API repeats the session check before any data read. */
export default async function RosterPage() {
  if (!await getSessionAccountId()) redirect("/login");
  return <RosterPanel />;
}
