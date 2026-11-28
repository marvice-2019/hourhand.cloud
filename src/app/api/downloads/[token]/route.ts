import { NextResponse, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { takeDownload } from "@/lib/products/products";

export const dynamic = "force-dynamic";

/** A buyer's download (B20): only for a paid order, counted, and served as an attachment that can never run in the page. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = authEnabled() ? await takeDownload(getPool(process.env.DATABASE_URL as string), token) : "not_found";
  if (result === "not_found") return new NextResponse("Not found.", { status: 404 });
  if (result === "not_paid") return new NextResponse("This order isn't paid, or it was refunded.", { status: 403 });
  if (result === "limit") return new NextResponse("This order has used all its downloads. Ask the seller for a new link.", { status: 410 });
  const ascii = result.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      "content-type": result.mime, "content-length": String(result.data.length),
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store",
    },
  });
}
