// Fails when a host-visible word is typed into dashboard code instead of coming from the host catalogue.
import { describe, expect, it } from "vitest";
import { dashboardFiles, looksLikeCopy, readRepoFile, scanSource } from "./scan";

/**
 * Files that may still hold English typed in. Only for a page that has to ship before its strings are extracted;
 * extract them in a follow-up (docs/i18n-host.md). Each entry says why.
 */
const PENDING: Record<string, string> = {
  "src/app/dashboard/earnings/export/route.ts": "CSV column headers stay English so spreadsheets and accountants' imports keep working",
  "src/app/dashboard/invoices/export/route.ts": "CSV column headers stay English so spreadsheets and accountants' imports keep working",
  "src/app/dashboard/clients/[key]/export/route.ts": "a client's data export the host may pass on to the client; its JSON/HTML stays English like the record it copies",
};

describe("host dashboard strings", () => {
  it("has no hard-coded words left in dashboard pages, actions or the components they use", () => {
    const findings = dashboardFiles().filter((f) => !(f in PENDING)).flatMap((f) => scanSource(f, readRepoFile(f)));
    const report = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
    expect(findings, `Move these into src/lib/i18n/host/en (see docs/i18n-host.md):\n${report}`).toEqual([]);
  });

  it("covers every dashboard page and the components it pulls in", () => {
    const files = dashboardFiles();
    expect(files).toContain("src/app/dashboard/bookings/[id]/page.tsx");
    expect(files).toContain("src/app/dashboard/layout.tsx");
    expect(files).toContain("src/components/EventTypeEditor.tsx");
    expect(files).toContain("src/components/ui/Button.tsx");
  });

  it("catches copy and lets code through", () => {
    const found = scanSource("x.tsx", `
      const STATE = { open: { label: "Open", className: "bg-success-bg text-success" } };
      export function P({ n }: { n: number }) {
        if (n === 2) return { status: "error", message: \`Keep it under \${n} characters.\` };
        return <div className="mt-4 flex" aria-label="Close menu">Hello there<input placeholder="Your name" type="text" />{"Saved."}{t("bookings.title")}<a href="/dashboard/x">Hourhand</a></div>;
      }`).map((f) => f.text);
    expect(found).toEqual(["Open", "Keep it under {} characters.", "Close menu", "Hello there", "Your name", "Saved."]);
    expect(looksLikeCopy("select id from users where id = $1")).toBe(false);
    expect(looksLikeCopy("inline-flex min-h-11 items-center")).toBe(false);
    expect(looksLikeCopy("Asia/Kolkata")).toBe(false);
  });
});
