import type { EvidenceChainData } from "@/lib/types";

import { Card, DataTable, Kicker } from "../ui";
import { displayGrain, formatNumber, ruleVersionList, shortHash, sourceHashes } from "./TraceFlow";

// Lane C (#22). The full `getEvidence` record for the selected claim: source rows,
// recomputation, transform and versions, hashes, report text, and lineage edges.

type Source = EvidenceChainData["sources"][number];
type Edge = NonNullable<EvidenceChainData["lineage"]>[number];

export function ClaimEvidence({ chain }: { chain: EvidenceChainData }) {
  const { claim } = chain;
  const hashes = sourceHashes(chain);
  const versions = ruleVersionList(chain);
  return (
    <Card stack aria-labelledby="hx-evidence-h" data-testid="claim-evidence">
      <div>
        <Kicker>Claim evidence · {claim.claim_id}</Kicker>
        <h2 id="hx-evidence-h">Source records, recomputation and lineage</h2>
        <p className="hx-sub">The backend recomputes the value from the frozen source IDs. This view only displays the returned evidence.</p>
      </div>
      <dl className="hx-evidence-facts" data-testid="claim-lineage">
        <div>
          <dt>Stored claim</dt>
          <dd>{claim.value === null ? "Needs review" : `${formatNumber(claim.value)} ${claim.unit}`}</dd>
        </div>
        <div>
          <dt>Recomputed</dt>
          <dd>{chain.recomputed_value === null ? "Not calculated" : `${formatNumber(chain.recomputed_value)} ${claim.unit}`}</dd>
        </div>
        <div>
          <dt>Exact match</dt>
          <dd>{chain.exact_match === null ? "Human judgment" : chain.exact_match ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Grain</dt>
          <dd>{displayGrain(claim.grain)}</dd>
        </div>
        <div>
          <dt>Transform</dt>
          <dd className="hx-mono">
            {chain.transform_id ?? "None"} {chain.transform_version ?? ""}
          </dd>
        </div>
        <div>
          <dt>Source hashes</dt>
          <dd className="hx-mono">{hashes.length > 0 ? hashes.map(shortHash).join(" · ") : "None"}</dd>
        </div>
        <div>
          <dt>Rule versions</dt>
          <dd className="hx-mono">{versions.length > 0 ? versions.join(" · ") : "None"}</dd>
        </div>
        <div>
          <dt>Report text</dt>
          <dd>{chain.report_text}</dd>
        </div>
      </dl>

      {chain.sources.length > 0 ? (
        <DataTable<Source>
          label={`Source records used by ${chain.transform_id ?? "the report field"}`}
          data-testid="source-records"
          template="150px 110px 70px 60px minmax(0, 1fr) 100px minmax(0, 1.4fr)"
          rows={chain.sources}
          rowKey={(source) => source.record_id}
          columns={[
            { key: "record", header: "Record", cell: (source) => <span className="hx-mono">{source.record_id}</span> },
            { key: "animal", header: "Animal", cell: (source) => text(source.attributes.animal_id) },
            { key: "group", header: "Group", cell: (source) => text(source.attributes.group_id) },
            { key: "sex", header: "Sex", cell: (source) => text(source.attributes.sex) },
            { key: "when", header: "Timepoint or tissue", cell: (source) => text(source.attributes.timepoint ?? source.attributes.tissue ?? "Study") },
            {
              key: "value",
              header: "Value",
              cell: (source) => (
                <strong>
                  {typeof source.value === "number" ? formatNumber(source.value) : source.value} {source.unit}
                </strong>
              ),
            },
            { key: "pointer", header: "Source pointer", cell: (source) => <span className="hx-mono hx-ellipsis">{source.source_pointer}</span> },
          ]}
        />
      ) : (
        <p className="hx-sub">This scientific-judgment field has no source value. The gap is deliberate.</p>
      )}

      {(chain.lineage?.length ?? 0) > 0 && (
        <DataTable<Edge>
          label="Lineage edges"
          data-testid="lineage-edges"
          template="130px 150px minmax(0, 1fr) 70px 150px"
          rows={chain.lineage ?? []}
          rowKey={(edge) => edge.edge_id}
          columns={[
            { key: "edge", header: "Edge", cell: (edge) => <span className="hx-mono">{edge.edge_id}</span> },
            { key: "record", header: "Source record", cell: (edge) => <span className="hx-mono">{edge.source_record_id}</span> },
            { key: "pointer", header: "Pointer", cell: (edge) => <span className="hx-mono hx-ellipsis">{edge.source_pointer}</span> },
            { key: "tier", header: "Tier", cell: (edge) => String(edge.authority_tier) },
            {
              key: "transform",
              header: "Transform",
              cell: (edge) => <span className="hx-mono">{`${edge.transform_id}${edge.transform_version ? `@${edge.transform_version}` : ""}`}</span>,
            },
          ]}
        />
      )}
    </Card>
  );
}

function text(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "Not recorded" : String(value);
}
