import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, publicUrl } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";

// Read per request: whether the visitor is signed in decides the response, so nothing here may be prerendered.
export const dynamic = "force-dynamic";

let homepage: Promise<string> | undefined;

/** "/" sends a signed-in host to the dashboard; everyone else gets the static marketing homepage from public/site. */
export async function GET(request: NextRequest): Promise<Response> {
  if (authEnabled() && (await getSignedInUser())) {
    return NextResponse.redirect(publicUrl("/dashboard/event-types", request), 307);
  }
  homepage ??= readFile(path.join(process.cwd(), "public", "site", "index.html"), "utf8");
  return new Response(await homepage, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
