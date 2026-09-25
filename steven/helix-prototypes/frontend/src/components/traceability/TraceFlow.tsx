import type { EvidenceChainData, ValidationResult } from "@/lib/types";

import { Kicker, cx } from "../ui";

// Lane C (#22). The five-step flow for one open rule (research/helix-e2e-workbench-v1.html,
// `TRACE`). Every value comes from `getEvidence`.

export type FlowTone = "pass" | "warn" | "block";

type Step = { key: string; kicker: string; value: string; detail: string };

/**
 * Which steps a rule checks. Presentation only (the reference highlights the steps the
 * rule covers); it never changes a result. Unknown rules highlight the validated claim.
 */
const RULE_FOCUS: Record<string, number[]> = {
  "manifest-locked": [0, 1],
  "bw-key-unique": [1],
  "claim-provenance": [0, 4],
  "grain-sex-stratified": [2, 3, 4],
  "mi-severity-reconcile": [3, 4],
  "noael-human-judgment": [3, 4],
};

export function ruleFocus(ruleId: string): number[] {
  return RULE_FOCUS[ruleId] ?? [3];
}

export function buildSteps(chain: EvidenceChainData): Step[] {
  const { claim, sources } = chain;
  const first = sources.at(0);
  const last = sources.at(-1);
  const authority = chain.lineage?.at(0)?.authority_tier;
  const grainKey = Object.entries(claim.grain_key ?? {}).map(([key, value]) => `${key}=${value}`);

  // One detail line per step, as in the reference. Hashes, recomputation, exact match and
  // rule versions are listed in full in ClaimEvidence; receipts in CandidateReceipts.
  return [
    {
      key: "source",
      kicker: "1 · Frozen source",
      value: sources.length > 0 ? `${sources.length} ${first?.domain ?? ""} records`.replace("  ", " ") : "No source records",
      detail: first ? pointerRange(first.source_pointer, last?.source_pointer) : "Scientific judgment: no source value",
    },
    {
      key: "facts",
      kicker: "2 · Normalized facts",
      value: displayGrain(first?.grain ?? claim.grain),
      detail: [
        `domain=${first?.domain ?? "none"}`,
        `unit=${first?.unit ?? claim.unit ?? "none"}`,
        `authority=${authority ?? "n/a"}`,
      ].join(" · "),
    },
    {
      key: "transform",
      kicker: "3 · Transform",
      value: chain.transform_id ?? "No transform",
      detail: [...grainKey, `inputs=${sources.length}`].join(" · "),
    },
    {
      key: "claim",
      kicker: "4 · Validated claim",
      value: claim.value === null ? "Needs review" : `${formatNumber(claim.value)} ${claim.unit}`,
      detail: `${claim.claim_id} · ${displayGrain(claim.grain).toLowerCase()}`,
    },
    {
      key: "report",
      kicker: "5 · Report field",
      value: `Section ${claim.section_id}`,
      detail: chain.report_text,
    },
  ];
}

/** "A-BW#M401:DAY28 … F405:DAY28": the last pointer drops the prefix it shares with the first. */
export function pointerRange(first: string, last: string | undefined): string {
  if (!last || last === first) return first;
  const hash = first.indexOf("#");
  const prefix = hash >= 0 ? first.slice(0, hash + 1) : "";
  return `${first} … ${prefix && last.startsWith(prefix) ? last.slice(prefix.length) : last}`;
}

export function TraceFlow({
  chain,
  result,
  tone,
}: {
  chain: EvidenceChainData;
  result: ValidationResult;
  tone: FlowTone;
}) {
  const focus = ruleFocus(result.rule_id);
  return (
    <ol className="hx-flow" aria-label="Traceability flow" data-testid="trace-flow">
      {buildSteps(chain).map((step, index) => {
        const focused = focus.includes(index);
        return (
          <li key={step.key} className={cx(focused && `f-${tone}`)} data-step={step.key} data-focused={focused || undefined}>
            <Kicker size="sm" className={cx("hx-flow-kicker", focused && `is-${tone}`)}>
              {step.kicker}
            </Kicker>
            <div className="val">{step.value}</div>
            <div className="hx-mono hx-flow-detail">{step.detail}</div>
          </li>
        );
      })}
    </ol>
  );
}

export function shortHash(value: string): string {
  const [algo, digest] = value.includes(":") ? value.split(":", 2) : ["", value];
  return `${algo ? `${algo}:` : ""}${digest.slice(0, 12)}`;
}

export function displayGrain(grain: string): string {
  const text = grain.replaceAll("_x_", " × ").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

/** Source hashes the server returned: the chain's, else the claim's, else the lineage edges'. */
export function sourceHashes(chain: EvidenceChainData): string[] {
  if (chain.source_hashes?.length) return chain.source_hashes;
  if (chain.claim.source_hashes?.length) return chain.claim.source_hashes;
  return [...new Set((chain.lineage ?? []).map((edge) => edge.source_hash).filter((hash): hash is string => Boolean(hash)))];
}

/** Rule versions the server returned: the chain's map, else the claim's, else each attached result's. */
export function ruleVersionList(chain: EvidenceChainData): string[] {
  const map = Object.keys(chain.rule_versions ?? {}).length ? chain.rule_versions : chain.claim.rule_versions;
  if (map && Object.keys(map).length > 0) return Object.entries(map).map(([rule, version]) => `${rule}@${version}`);
  return [...new Set(chain.validations.map((result) => `${result.rule_id}@${result.rule_version}`))];
}
