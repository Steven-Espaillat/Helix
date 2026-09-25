import { notFound } from "next/navigation";

import { ReportParityFixture } from "./ReportParityFixture";

// Report Assembly + ChatDock parity fixture (restyle before/after, report-only screens).
// Display state only: every API request is answered from fixture.json in the browser and never
// reaches a server. 404 unless the server runs with HELIX_PARITY_FIXTURES=1.
export const dynamic = "force-dynamic";

export default function ReportParityPage() {
  if (process.env.HELIX_PARITY_FIXTURES !== "1") {
    notFound();
  }
  return <ReportParityFixture />;
}
