// Pages link /icon.svg, but some browsers and tools still ask for /favicon.ico; send them to the PNG icon.
export function GET() {
  return new Response(null, { status: 308, headers: { Location: "/icons/192" } });
}
