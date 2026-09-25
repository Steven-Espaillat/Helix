import { notFound } from "next/navigation";

import { ReviewParityFixture } from "./ReviewParityFixture";

// Lane D (#23) parity fixture: Human Gate 3 with a captured review-export workspace, because a
// fresh seed (the parity kit's server) cannot get past Upload without a human freeze. Display
// state only: no API calls, no freeze, no qualification path, demo flag off. 404 unless the
// server runs with HELIX_PARITY_FIXTURES=1.
export const dynamic = "force-dynamic";

export default function ReviewParityPage() {
  if (process.env.HELIX_PARITY_FIXTURES !== "1") {
    notFound();
  }
  return <ReviewParityFixture />;
}
