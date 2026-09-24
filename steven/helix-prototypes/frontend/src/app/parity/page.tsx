import { notFound } from "next/navigation";

import { ParityFixture, type FixtureName } from "./ParityFixture";

// Component fixtures for the visual parity kit (tests/parity). Disabled unless
// the server runs with HELIX_PARITY_FIXTURES=1, so normal builds return 404.
export const dynamic = "force-dynamic";

const FIXTURES: FixtureName[] = ["upload"];

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ParityPage({ searchParams }: Props) {
  if (process.env.HELIX_PARITY_FIXTURES !== "1") {
    notFound();
  }
  const params = await searchParams;
  const fixture = String(params.fixture ?? "") as FixtureName;
  if (!FIXTURES.includes(fixture)) {
    notFound();
  }
  const stage = Math.max(0, Math.min(9, Number.parseInt(String(params.stage ?? "0"), 10) || 0));
  return <ParityFixture fixture={fixture} stage={stage} />;
}
