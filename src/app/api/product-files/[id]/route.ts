import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, publicUrl } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { MAX_FILE_BYTES, saveProductFile } from "@/lib/products/products";

export const dynamic = "force-dynamic";

/**
 * Uploads (or replaces) a product's file from the dashboard form (B20), then sends the host back with the result.
 * Only the signed-in host who owns the product; the session cookie is SameSite=Lax and the Origin must be ours.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const back = (result: string) => NextResponse.redirect(publicUrl(`/dashboard/products?result=${result}#p-${encodeURIComponent(id)}`, request), 303);
  const origin = request.headers.get("origin");
  if (origin && origin !== publicUrl("/", request).origin) return new NextResponse("Forbidden.", { status: 403 });
  const host = await requireHost();
  if (!authEnabled()) return back("demo");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + 64 * 1024) return back("tooBig");
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return back("badType");
  }
  if (!(file instanceof File) || file.size === 0) return back("noFile");
  if (file.size > MAX_FILE_BYTES) return back("tooBig");
  const result = await saveProductFile(getPool(process.env.DATABASE_URL as string), host.id, id, { filename: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  return back({ saved: "fileSaved", not_found: "notFound", too_big: "tooBig", bad_type: "badType", host_full: "hostFull" }[result]);
}
