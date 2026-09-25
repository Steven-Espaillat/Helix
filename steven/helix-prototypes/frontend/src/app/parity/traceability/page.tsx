import { notFound } from "next/navigation";

import { TraceabilityFixture } from "./TraceabilityFixture";

// Lane C (#22) parity fixture: Human Gate 2 rendered with the reference copy
// (research/helix-e2e-workbench-v1.html, `?stage=7`). Tests only. It returns 404
// unless the server runs with HELIX_PARITY_FIXTURES=1, it seeds display state for the
// Traceability view alone, and it never calls the API (no freeze, qualification,
// validation or disposition command).
export const dynamic = "force-dynamic";

export default function TraceabilityParityPage() {
  if (process.env.HELIX_PARITY_FIXTURES !== "1") {
    notFound();
  }
  return <TraceabilityFixture />;
}
