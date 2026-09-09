import { notFound, redirect } from "next/navigation";
import ApplicationReviewPanel from "@/components/ApplicationReviewPanel";
import { getSessionAccountId } from "@/lib/auth";
import { validApplicationId } from "@/lib/application-review";

export const dynamic = "force-dynamic";

/** A manager-only browser entry point for the exact application review route. */
export default async function ApplicationReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!validApplicationId(id)) notFound();

  // The API repeats this check for every GET/PATCH. Keep it at page entry too,
  // so an unauthenticated visitor never receives the review interface.
  if (!await getSessionAccountId()) redirect("/login");

  return <ApplicationReviewPanel applicationId={id} />;
}
