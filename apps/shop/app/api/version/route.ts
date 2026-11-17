export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ sha: process.env.GIT_SHA ?? "unknown", testMode: process.env.TEST_MODE === "1" });
}
