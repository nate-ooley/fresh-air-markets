import { redirect } from "next/navigation";

// Old public signup links lead vendors to the in-app application form.
export default function SignupPage() {
  redirect("/apply");
}
