import type { NextRequest } from "next/server";
import { liveApiDeps } from "@/lib/api/deps";
import { handleApiRequest } from "@/lib/api/http";
import { listQuestionsApi } from "@/lib/api/v1";

export const dynamic = "force-dynamic";

/** B24: the key owner's paid and free questions (B19), oldest first, filtered by status, a page at a time. */
export async function GET(request: NextRequest) {
  return handleApiRequest(request, liveApiDeps(request), (ctx) => listQuestionsApi(ctx, request.nextUrl.searchParams));
}
