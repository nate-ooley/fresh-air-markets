import Image from "next/image";
import Link from "next/link";

export const MARKET = {
  name: "Fresh Air Markets & Events",
  market: "North Port Farmer's Market",
  phone: "(941) 740-8866",
  phoneHref: "9417408866",
  location: "US 41 & Sumter, North Port",
  hours: "9:00 AM – 1:00 PM",
  opening: "Saturday, October 3",
};

const NAV = [
  { href: "/about", label: "About" },
  { href: "/vendors", label: "Vendors" },
  { href: "/vendors#nonprofits", label: "Non-Profits" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-navy/10 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
        <Link href="/" className="flex items-center gap-3">
          <Image src="/site/logo.png" alt="Fresh Air Markets & Events" width={44} height={44} className="rounded-full" priority />
          <span className="font-display text-lg text-navy">Fresh Air Markets</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm font-medium text-navy/80 sm:flex">
          {NAV.map(item => <Link key={item.href} href={item.href} className="hover:text-sky">{item.label}</Link>)}
        </nav>
        <div className="flex items-center gap-3">
          <a href={`tel:${MARKET.phoneHref}`} className="hidden text-sm font-semibold text-navy sm:block">{MARKET.phone}</a>
          <Link href="/#contact" className="rounded-full bg-sky px-4 py-2 text-sm font-semibold text-white shadow hover:bg-navy">Contact Us</Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-navy/10 bg-navy text-white/80">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:grid-cols-3">
        <div>
          <div className="flex items-center gap-3">
            <Image src="/site/logo.png" alt="" width={40} height={40} className="rounded-full bg-white" />
            <span className="font-display text-lg text-white">{MARKET.name}</span>
          </div>
          <p className="mt-3 text-sm">Building stronger communities through vibrant outdoor markets and local connections in Southwest Florida.</p>
        </div>
        <div className="text-sm">
          <p className="font-semibold text-white">{MARKET.market}</p>
          <p className="mt-2">Every Saturday, {MARKET.hours}</p>
          <p>{MARKET.location}</p>
          <p className="mt-2"><a href={`tel:${MARKET.phoneHref}`} className="underline">{MARKET.phone}</a></p>
        </div>
        <div className="text-sm">
          <p className="font-semibold text-white">Vendors</p>
          <ul className="mt-2 space-y-1">
            <li><Link href="/vendors" className="hover:text-white">Become a vendor</Link></li>
            <li><Link href="/apply" className="hover:text-white">Start your application</Link></li>
            <li><Link href="/agreement" className="hover:text-white">Vendor Agreement</Link></li>
            <li><Link href="/login" className="hover:text-white">Market staff sign in</Link></li>
          </ul>
        </div>
      </div>
      <p className="border-t border-white/10 py-4 text-center text-xs text-white/50">© {new Date().getFullYear()} {MARKET.name}. All rights reserved.</p>
    </footer>
  );
}

export function InfoPills() {
  return (
    <div className="flex flex-wrap gap-3 text-sm font-medium text-navy">
      <span className="rounded-full bg-white/80 px-4 py-2 shadow-sm">📅 Every Saturday</span>
      <span className="rounded-full bg-white/80 px-4 py-2 shadow-sm">🕘 {MARKET.hours}</span>
      <span className="rounded-full bg-white/80 px-4 py-2 shadow-sm">📍 {MARKET.location}</span>
    </div>
  );
}
