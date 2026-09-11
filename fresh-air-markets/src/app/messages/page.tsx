import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionAccountId } from "@/lib/auth";
import { listContactMessages, listSubscribers } from "@/lib/portal-intake";

export const dynamic = "force-dynamic";

/** Manager inbox: website contact messages and newsletter signups. */
export default async function MessagesPage() {
  const marketId = await getSessionAccountId();
  if (!marketId) redirect("/login");
  let messages: Awaited<ReturnType<typeof listContactMessages>> = [];
  let subscribers: Awaited<ReturnType<typeof listSubscribers>> = [];
  let error = "";
  try {
    [messages, subscribers] = await Promise.all([listContactMessages(marketId), listSubscribers(marketId)]);
  } catch { error = "Messages are unavailable right now."; }
  const topic: Record<string, string> = { general: "General", vendor: "Vendor", nonprofit: "Non-profit" };
  return (
    <main className="min-h-screen bg-cream px-6 py-10">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-3xl text-pine-deep">Website messages</h1>
          <nav className="flex gap-4 text-sm text-pine-deep"><Link href="/applications" className="underline">Applications</Link><Link href="/staff" className="underline">Staff</Link></nav>
        </div>
        {error && <p className="mt-6 rounded-2xl bg-clay/10 p-4 text-clay">{error}</p>}
        <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
          <h2 className="font-semibold text-pine-deep">Contact form ({messages.length})</h2>
          {messages.length === 0 ? <p className="mt-3 text-sm text-ink/60">No messages yet.</p> : (
            <ul className="mt-4 divide-y divide-pine/10">
              {messages.map(m => (
                <li key={m.id} className="py-4">
                  <p className="text-sm text-ink/50">{new Date(m.createdAt).toLocaleString()} · {topic[m.topic] ?? m.topic}</p>
                  <p className="mt-1 font-semibold text-pine-deep">{m.firstName} {m.lastName} · <a href={`mailto:${m.email}`} className="underline">{m.email}</a>{m.phone ? ` · ${m.phone}` : ""}</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-ink/80">{m.message}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="mt-6 rounded-3xl bg-white p-6 shadow-sm ring-1 ring-pine/10">
          <h2 className="font-semibold text-pine-deep">Newsletter signups ({subscribers.length})</h2>
          {subscribers.length === 0 ? <p className="mt-3 text-sm text-ink/60">No signups yet.</p> : (
            <p className="mt-3 break-words text-sm text-ink/80">{subscribers.map(s => s.email).join(", ")}</p>
          )}
        </section>
      </div>
    </main>
  );
}
