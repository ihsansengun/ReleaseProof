import { applyPaymentEvent } from "@/lib/shop";

// Receives payment-provider events. In this demo the provider is simulated, so
// there is no signature to verify.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { eventId?: unknown; orderId?: unknown; type?: unknown }
    | null;
  if (
    !body ||
    typeof body.eventId !== "string" ||
    typeof body.orderId !== "number" ||
    typeof body.type !== "string"
  ) {
    return Response.json({ error: "eventId, orderId and type are required" }, { status: 400 });
  }
  const outcome = applyPaymentEvent({ eventId: body.eventId, orderId: body.orderId, type: body.type });
  return Response.json({ outcome });
}
