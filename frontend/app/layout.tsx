import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Seller Ledger — Ent-JFE',
  description:
    'Event-sourced order & payments dashboard: immutable event log, double-entry ledger, daily settlement.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-xs font-bold text-white">
                SL
              </span>
              Seller Ledger
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-600">
              <Link href="/" className="hover:text-slate-900">
                Dashboard
              </Link>
              <a
                href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/trial-balance`}
                target="_blank"
                rel="noreferrer"
                className="hidden hover:text-slate-900 sm:block"
              >
                Trial balance ↗
              </a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-8 pt-4 text-xs text-slate-400">
          Ent-JFE-20/05/26 — event store · double-entry ledger · idempotent payments
        </footer>
      </body>
    </html>
  );
}
