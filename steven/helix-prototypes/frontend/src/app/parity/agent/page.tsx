import { notFound } from "next/navigation";

import { AgentParityFixture } from "./AgentParityFixture";

// Lane B (#21) parity fixture: the Agent Step view over static, display-only
// fixture data, for the visual parity kit ONLY. Same gate as /parity: 404 unless
// the web server runs with HELIX_PARITY_FIXTURES=1. It calls no API, and it does
// not touch the freeze, qualification, or any other backend gate.
export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AgentParityPage({ searchParams }: Props) {
  if (process.env.HELIX_PARITY_FIXTURES !== "1") {
    notFound();
  }
  const params = await searchParams;
  // Agent Steps are reference stages 1-6 (Parse..Provenance); default Validate (4).
  const stage = Math.max(1, Math.min(6, Number.parseInt(String(params.stage ?? "4"), 10) || 4));
  return <AgentParityFixture stage={stage} />;
}
