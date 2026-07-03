import { redirect } from "next/navigation";

/** Legacy path from v1 — the dashboard is the admin panel now. */
export default function AdminRedirect() {
  redirect("/dashboard");
}
