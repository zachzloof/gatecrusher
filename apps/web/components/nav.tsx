"use client";

import { ListMusic, Settings, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/playlists", label: "Playlists", icon: ListMusic },
  { href: "/settings", label: "Settings", icon: Settings },
];

/**
 * Bottom bar below 640px, icon rail up to 1024px, labelled rail above that.
 * The Needs-you counter joins this in slice 4.
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex h-14 border-t border-border bg-surface-1",
        "sm:sticky sm:inset-x-auto sm:top-0 sm:h-dvh sm:w-14 sm:shrink-0 sm:flex-col sm:border-t-0 sm:border-r",
        "lg:w-52",
      )}
    >
      <div className="hidden h-14 shrink-0 items-center px-4 sm:flex">
        <span className="font-mono text-13 font-medium tracking-label text-text uppercase">
          <span aria-hidden="true" className="lg:hidden">
            GC
          </span>
          <span className="sr-only lg:not-sr-only">Gatecrusher</span>
        </span>
      </div>

      <ul className="flex flex-1 sm:flex-none sm:flex-col sm:gap-1 sm:px-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="flex flex-1 sm:flex-none">
              <Link
                href={href}
                title={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-1 items-center justify-center gap-3 text-13 transition-colors duration-150 ease-out",
                  "sm:h-9 sm:flex-none sm:rounded-control lg:justify-start lg:px-3",
                  "sm:w-full",
                  active
                    ? "bg-surface-2 text-text"
                    : "text-text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="sr-only lg:not-sr-only">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
