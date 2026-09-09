import { redirect } from "next/navigation";
import ApplicationReviewList from "@/components/ApplicationReviewList";
import { getSessionAccountId } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Manager-only index; the API repeats the session check before any data read. */
export default async function ApplicationsPage() {
  if (!await getSessionAccountId()) redirect("/login");
  return <ApplicationReviewList />;
}
