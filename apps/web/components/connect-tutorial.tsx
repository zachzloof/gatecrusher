import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { SectionLabel } from "@/components/section-label";

// How to copy SoundCloud's `oauth_token` cookie out of a browser, step by step. Static:
// nothing here touches SoundCloud or the token.

/** Made up, in the shape of a real one, for the picture of the cookie row. */
const EXAMPLE_TOKEN = "2-290123-123456789-aBcDeFgHiJkLmN";

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-control border border-border bg-surface-2 px-1.5 py-px font-mono text-xs text-text">
      {children}
    </kbd>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-13 text-text">{children}</code>;
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-x-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="flex size-6 items-center justify-center rounded-full border border-border font-mono text-xs text-text-muted tabular-nums"
      >
        {number}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-text">{title}</h3>
        <div className="mt-1 grid gap-2 text-13 text-text-muted">{children}</div>
      </div>
    </li>
  );
}

/** A picture of the developer-tools cookie table, built from text so it reads aloud. */
function CookieRowExample() {
  return (
    <figure className="mt-1">
      <div className="overflow-x-auto rounded-control border border-border bg-bg">
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-xs">
          <span className="text-text-faint">Filter</span>
          <span className="rounded-control border border-border bg-surface-2 px-2 py-px text-text">
            oauth_token
          </span>
        </div>
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="border-b border-border text-left text-text-faint">
              <th scope="col" className="px-3 py-1.5 font-normal">
                Name
              </th>
              <th scope="col" className="px-3 py-1.5 font-normal">
                Value
              </th>
              <th scope="col" className="hidden px-3 py-1.5 font-normal sm:table-cell">
                Domain
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-3 py-1.5 whitespace-nowrap text-text">oauth_token</td>
              <td className="px-3 py-1.5">
                <span className="rounded-control bg-info/15 px-1 break-all text-text outline outline-1 outline-info">
                  {EXAMPLE_TOKEN}
                </span>
              </td>
              <td className="hidden px-3 py-1.5 whitespace-nowrap text-text-muted sm:table-cell">
                .soundcloud.com
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <figcaption className="mt-1.5 text-xs text-text-muted">
        The row to look for. Copy the outlined Value; yours is different from this made-up one.
      </figcaption>
    </figure>
  );
}

function OtherBrowser({ name, children }: { name: string; children: ReactNode }) {
  return (
    <details className="group border-t border-border px-4 py-3 text-13">
      <summary className="cursor-pointer text-text-muted transition-colors duration-150 ease-out hover:text-text">
        Using {name}?
      </summary>
      <div className="mt-2 grid gap-2 text-text-muted">{children}</div>
    </details>
  );
}

export function ConnectTutorial() {
  return (
    <>
      <section aria-labelledby="before-heading" className="mb-6">
        <SectionLabel id="before-heading">Before you start</SectionLabel>
        <ul className="grid gap-3 rounded-panel border border-border bg-surface-1 px-4 py-3 text-13 text-text-muted">
          <li>
            <span className="font-medium text-text">Use a burner account.</span> Every download runs
            as this account. Make a separate free SoundCloud account for Gatecrusher instead of
            using your main one.
          </li>
          <li>
            <span className="font-medium text-text">The token works like a password.</span> Anyone
            who has it can use the account until it signs out. Don&apos;t paste it anywhere else or
            share a screenshot of it.
          </li>
          <li>
            <span className="font-medium text-text">It stays on this computer.</span> Gatecrusher
            keeps it in the local database, passes it only to yt-dlp, and never shows it again.
            Disconnect any time in Settings.
          </li>
        </ul>
      </section>

      <section aria-labelledby="steps-heading" className="mb-6">
        <SectionLabel id="steps-heading">Find your oauth_token</SectionLabel>
        <div className="rounded-panel border border-border bg-surface-1">
          <p className="border-b border-border px-4 py-3 text-13 text-text-muted">
            About two minutes. These steps are for Chrome, Edge and Brave; Firefox and Safari are
            below them. Use a computer, not a phone.
          </p>
          <ol className="divide-y divide-border">
            <Step number={1} title="Sign in at soundcloud.com">
              <p>
                Open SoundCloud in your usual browser and sign in with the account Gatecrusher
                should use. Check the avatar in the top-right corner is that account.
              </p>
              <p>
                <a
                  href="https://soundcloud.com/signin"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-text underline underline-offset-2 hover:text-info"
                >
                  Open soundcloud.com
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </p>
            </Step>
            <Step number={2} title="Open the developer tools">
              <p>
                On the SoundCloud tab, press <Key>F12</Key>, or <Key>Ctrl</Key>+<Key>Shift</Key>+
                <Key>I</Key> (on a Mac <Key>Cmd</Key>+<Key>Option</Key>+<Key>I</Key>). A panel opens
                beside or below the page.
              </p>
            </Step>
            <Step number={3} title="Go to SoundCloud's cookies">
              <p>
                Click the <span className="text-text">Application</span> tab along the top of the
                panel. If it isn&apos;t there, click <Key>»</Key> to see more tabs. In the list on
                the left, open <span className="text-text">Storage → Cookies</span> and click{" "}
                <Code>https://soundcloud.com</Code>.
              </p>
            </Step>
            <Step number={4} title="Find the oauth_token row">
              <p>
                Type <Code>oauth_token</Code> into the <span className="text-text">Filter</span> box
                above the table. One row is left:
              </p>
              <CookieRowExample />
            </Step>
            <Step number={5} title="Copy its value">
              <p>
                Double-click the <span className="text-text">Value</span> cell of that row so all of
                it is selected, then press <Key>Ctrl</Key>+<Key>C</Key> (<Key>Cmd</Key>+<Key>C</Key>{" "}
                on a Mac). Copy the value only, not the name. It usually starts with <Code>2-</Code>{" "}
                and is around 30 characters long.
              </p>
            </Step>
            <Step number={6} title="Paste it below">
              <p>
                Paste it into the box under these steps and click{" "}
                <span className="text-text">Connect</span>. Gatecrusher checks it with SoundCloud
                before saving anything. Then close the developer tools; you can keep using
                SoundCloud as normal.
              </p>
            </Step>
          </ol>

          <OtherBrowser name="Firefox">
            <p>
              Press <Key>F12</Key> and open the <span className="text-text">Storage</span> tab. On
              the left, open <span className="text-text">Cookies</span> and click{" "}
              <Code>https://soundcloud.com</Code>. Type <Code>oauth_token</Code> into the filter
              box, double-click the row&apos;s <span className="text-text">Value</span> and copy it.
            </p>
          </OtherBrowser>
          <OtherBrowser name="Safari">
            <p>
              First turn the developer tools on:{" "}
              <span className="text-text">Safari → Settings → Advanced</span>, then tick{" "}
              <span className="text-text">Show features for web developers</span>. On the SoundCloud
              tab choose <span className="text-text">Develop → Show Web Inspector</span>, open the{" "}
              <span className="text-text">Storage</span> tab, then{" "}
              <span className="text-text">Cookies → soundcloud.com</span>. Double-click the{" "}
              <span className="text-text">Value</span> of <Code>oauth_token</Code> and copy it.
            </p>
          </OtherBrowser>
        </div>
      </section>

      <section aria-labelledby="trouble-heading" className="mb-6">
        <SectionLabel id="trouble-heading">If it doesn&apos;t work</SectionLabel>
        <dl className="grid gap-3 rounded-panel border border-border bg-surface-1 px-4 py-3 text-13">
          <div>
            <dt className="font-medium text-text">There is no oauth_token row</dt>
            <dd className="mt-0.5 text-text-muted">
              That tab isn&apos;t signed in, or you&apos;re looking at another site&apos;s cookies.
              Sign in, reload the page, and look again under <Code>https://soundcloud.com</Code>.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-text">
              &ldquo;SoundCloud did not accept that token&rdquo;
            </dt>
            <dd className="mt-0.5 text-text-muted">
              Part of the value was missed, or that browser has since signed out. Copy it again;
              double-clicking the cell selects all of it.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-text">
              Downloads later fail with &ldquo;Connect SoundCloud again&rdquo;
            </dt>
            <dd className="mt-0.5 text-text-muted">
              The token stops working when that browser signs out of SoundCloud, and may expire
              after a while. Repeat these steps and paste the new value. Staying signed in, rather
              than clicking Sign out, keeps it working.
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
