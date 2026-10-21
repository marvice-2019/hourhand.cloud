"use client";

import { useEffect, useRef, useState } from "react";
import { BREAK_HASH, easeOut, ink } from "./ink";
import { Mark } from "./Mark";

type Status = "ok" | "disconnected";

const slots = ["9:00 am", "10:30 am", "12:00 pm", "2:00 pm", "3:30 pm", "5:00 pm"];

const fade = `transition-[opacity,filter] duration-[420ms] ${easeOut} motion-reduce:transition-none`;

function Light({ status, label, flash }: { status: Status; label: string; flash: boolean }) {
  const ok = status === "ok";
  return (
    <span className={`inline-flex shrink-0 items-center gap-2 rounded-pill px-2.5 py-1 text-xs tabular-nums ${ok ? ink.successPill : ink.dangerPill}`}>
      <span aria-hidden className="relative flex size-2">
        {flash && <span className="absolute inset-0 animate-ping rounded-pill bg-current opacity-60 [animation-iteration-count:2] motion-reduce:hidden" />}
        <span className="relative size-2 rounded-pill bg-current" />
      </span>
      {label}
    </span>
  );
}

/**
 * The landing page's signature: a dashboard calendars panel beside the guest's booking page.
 * Breaking one calendar turns its light red and pauses every time on the booking page, as the product does.
 */
export function SyncDemo() {
  const [outlook, setOutlook] = useState<Status>("ok");
  const [changed, setChanged] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const paused = outlook === "disconnected";

  useEffect(() => {
    // Runs on arrival with the hash and on every later click of a link to it; the state change happens in the event's callback.
    function breakFromHash() {
      if (window.location.hash !== BREAK_HASH) return;
      setOutlook("disconnected");
      setChanged((n) => n + 1);
      button.current?.focus({ preventScroll: true });
    }
    // A second click on a link to the hash fires no hashchange, so clicks on those links break the calendar too.
    function breakFromLink(e: MouseEvent) {
      if (e.target instanceof Element && e.target.closest(`a[href="${BREAK_HASH}"]`) && window.location.hash === BREAK_HASH) breakFromHash();
    }
    const id = window.setTimeout(breakFromHash, 0);
    window.addEventListener("hashchange", breakFromHash);
    document.addEventListener("click", breakFromLink);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("hashchange", breakFromHash);
      document.removeEventListener("click", breakFromLink);
    };
  }, []);

  const calendars: { provider: string; name: string; status: Status; checked: string }[] = [
    { provider: "Google", name: "Sessions", status: "ok", checked: "In sync · checked 2 min ago" },
    { provider: "Outlook", name: "Clinic (work)", status: outlook, checked: paused ? "Disconnected. Bookings paused" : "In sync · checked 4 min ago" },
    { provider: "iCloud", name: "Personal", status: "ok", checked: "In sync · checked 1 min ago" },
  ];

  function toggle() {
    setOutlook((s) => (s === "ok" ? "disconnected" : "ok"));
    setChanged((n) => n + 1);
  }

  return (
    <div id={BREAK_HASH.slice(1)} className="scroll-mt-24">
      <div className={`${ink.frame} p-2 sm:p-3`} role="group" aria-label="Example: Priya's calendars and her booking page">
        <div className={`flex items-center gap-4 border-b px-2 pb-2.5 pt-1 text-xs sm:px-3 ${ink.line} ${ink.muted}`} aria-hidden>
          <span className={`flex items-center gap-2 font-display text-sm ${ink.text}`}>
            <Mark size="size-4" />
            hourhand
          </span>
          <span className={ink.text}>Calendars</span>
          <span className="hidden sm:inline">Bookings</span>
          <span className="hidden sm:inline">Booking page</span>
          <span className="ml-auto hidden md:inline">Priya Raman</span>
        </div>

        <div className="grid gap-2 pt-2 sm:gap-3 sm:pt-3 md:grid-cols-[1fr_1.15fr]">
          <section className={`${ink.pane} p-4 sm:p-5`} aria-label="Calendars checked for conflicts">
            <p className={`text-sm font-semibold ${ink.text}`}>Calendars checked for conflicts</p>
            <p className={`mt-1 text-xs ${ink.muted}`}>If one can&apos;t be checked, your booking page stops offering times.</p>
            <ul className={`mt-4 divide-y ${ink.divide}`}>
              {calendars.map((c) => (
                <li key={c.provider} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                  <span className="min-w-[7.5rem] flex-1">
                    <span className={`block text-sm ${ink.text}`}>{c.name}</span>
                    <span className={`block text-xs ${ink.muted}`}>{c.provider}</span>
                  </span>
                  <Light status={c.status} label={c.checked} flash={c.provider === "Outlook" && changed > 0} key={`${c.provider}-${changed}`} />
                </li>
              ))}
            </ul>
          </section>

          <section className={`${ink.pane} p-4 sm:p-5`} aria-label="Priya's booking page, as a guest sees it">
            <p className={`text-base font-semibold ${ink.text}`}>45-minute coaching session</p>
            <p className={`mt-0.5 text-xs ${ink.muted}`}>with Priya · Google Meet</p>
            <div className={`mt-4 flex items-center justify-between border-t pt-4 text-xs ${ink.line} ${ink.muted}`}>
              <span className={ink.text}>Thu, 23 Oct</span>
              <span>Pick a time</span>
            </div>

            {/* Times and the paused notice share one grid cell, so the pane grows to whichever is taller. */}
            <div className="mt-3 grid">
              <div className={`[grid-area:1/1] ${fade} ${paused ? "opacity-[0.28] saturate-0" : ""}`} aria-hidden={paused}>
                <div className="grid grid-cols-3 gap-2">
                  {slots.map((t) => (
                    <span
                      key={t}
                      className={`rounded-sm border py-2.5 text-center text-sm tabular-nums ${
                        t === "10:30 am" ? `border-transparent ${ink.accentBg} font-semibold` : `${ink.lineStrong} ${ink.text}`
                      }`}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <p className={`mt-3 text-xs ${ink.muted} ${paused ? "opacity-0" : ""}`}>
                  Times shown in India Standard Time (your time) · <span className="whitespace-nowrap">12h / 24h</span>
                </p>
              </div>

              <div
                className={`[grid-area:1/1] self-start rounded-md border p-4 ${ink.lineStrong} bg-[#1b1511] transition-[clip-path,opacity] duration-[480ms] ${easeOut} motion-reduce:transition-none ${
                  paused ? "opacity-100 [clip-path:inset(0_0_0_0_round_10px)]" : "pointer-events-none invisible opacity-0 [clip-path:inset(0_0_100%_0_round_10px)]"
                }`}
                aria-hidden={!paused}
              >
                <p className={`flex items-center gap-2 text-sm font-semibold ${ink.danger}`}>
                  <span aria-hidden className="size-2 rounded-pill bg-current" />
                  Bookings paused
                </p>
                <p className={`mt-2 text-sm ${ink.text}`}>
                  Priya&apos;s Outlook calendar can&apos;t be checked right now, so no times are offered. Nobody can book over a session.
                </p>
                <p className={`mt-2 text-xs ${ink.muted}`}>Priya has been emailed a link to reconnect.</p>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          ref={button}
          type="button"
          onClick={toggle}
          aria-pressed={paused}
          className={`inline-flex h-11 items-center gap-2 rounded-md border px-4 text-sm font-semibold transition-colors duration-(--hh-motion-fast) hover:bg-[#1b1511] ${ink.lineStrong} ${ink.text} ${ink.focus}`}
        >
          <span aria-hidden className={`size-2 rounded-pill ${paused ? "bg-[#5cc28e]" : "bg-[#f07a6a]"}`} />
          {paused ? "Reconnect Outlook" : "Break the Outlook calendar"}
        </button>
        <p className={`text-sm ${ink.muted}`}>Try it. Example data, showing how the dashboard and booking page react.</p>
        <p className="sr-only" aria-live="polite">
          {changed === 0 ? "" : paused ? "Outlook disconnected. The booking page has paused all times." : "Outlook reconnected. Times are offered again."}
        </p>
      </div>
    </div>
  );
}
