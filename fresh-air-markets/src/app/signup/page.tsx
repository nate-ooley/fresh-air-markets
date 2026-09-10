import { redirect } from "next/navigation";

// Old public signup links must lead vendors to the existing application form.
export default function SignupPage() {
  redirect("https://freshairmarketsandevents.com/vendors");
}
