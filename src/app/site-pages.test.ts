import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sitemap from "./sitemap";

// The marketing pages in public/site are served at /coaches, /tutors and so on, with no trailing slash: a URL with one
// answers 308 to the bare path. Their canonical, og:url and breadcrumb links must name the address that answers 200,
// the same one the sitemap lists, or search engines are told a redirect is the page.
const siteDir = path.join(process.cwd(), "public", "site");
const pages = readdirSync(siteDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const ownUrls = (html: string) => [...html.matchAll(/https:\/\/hourhand\.cloud\/[^"\s<]*/g)].map((m) => m[0]);

describe("marketing page URLs", () => {
  it("finds the pages", () => expect(pages.length).toBeGreaterThan(0));

  for (const page of pages) {
    it(`${page}: every own URL other than the home page has no trailing slash`, () => {
      const html = readFileSync(path.join(siteDir, page, "index.html"), "utf8");
      const urls = ownUrls(html);
      expect(urls).toContain(`https://hourhand.cloud/${page}`);
      expect(urls.filter((u) => u !== "https://hourhand.cloud/" && u.endsWith("/"))).toEqual([]);
    });

    it(`${page}: canonical is the address the sitemap lists`, () => {
      const html = readFileSync(path.join(siteDir, page, "index.html"), "utf8");
      const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
      expect(sitemap().map((e) => e.url.replace(/^https?:\/\/[^/]+/, "https://hourhand.cloud"))).toContain(canonical);
    });
  }
});
