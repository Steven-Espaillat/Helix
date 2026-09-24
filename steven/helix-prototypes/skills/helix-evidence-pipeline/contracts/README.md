# HELIX package contracts

These JSON Schemas define the records that connect deterministic validation, Codex SDK section runs, and report gates.

| Contract | Purpose |
| --- | --- |
| `data-validation-package.schema.json` | Declares one evidence-domain validator, its exact executors, rules, outputs, and tests. |
| `section-package.schema.json` | Declares one report section's dependencies, claims, skill, gates, and drafting limits. |
| `section-execution-envelope.schema.json` | Limits one Section Agent invocation to the context allowed for that section. |
| `section-draft-candidate.schema.json` | Validates the only successful output that a Section Agent can return. |
| `section-draft.schema.json` | Records deterministic promotion of one exact candidate after blocking gates pass. |
| `review-scaffold-revision.schema.json` | Records one immutable, study-wide review rendering that can contain `[NEEDS REVIEW]` placeholders and can never be exported. |
| `release-candidate.schema.json` | Rejects `status: "review_scaffold"` and requires `export_eligible: true` so a Review Scaffold cannot be admitted as a release candidate. |
| `run-plan.schema.json` | Stores the immutable dependency graph resolved for one Pinned Run. |
| `provenance-receipt.schema.json` | Records deterministic claim bindings for one Section Draft Candidate. |
| `study-output-evaluation-receipt.schema.json` | Records advisory Promptfoo study-output results without gate authority. |
| `template-conformance-receipt.schema.json` | Records post-draft Template Conformance Gate results. |
| `cross-section-query-receipt.schema.json` | Records requested artifact IDs and returned hashes for one audited query. |
| `candidate-evaluation.schema.json` | Persists one Candidate Attempt with its three evaluation receipts and next-attempt decision. |
| `section-promotion-decision.schema.json` | Records the five deterministic promotion conditions, failed IDs, warnings, and current dispositions for one candidate. |

JSON Schema cannot prove that a `RunPlan` is acyclic or that each dependency exists. The backend must check both conditions before it stores the plan.

A complete package with `qualification_status: pending` or `failed` cannot enter a production Pinned Run. A test-only Section Package with `maturity: vertical_slice` may remain pending, but it must set `promotion_allowed` to `false`.

Validate the JSON syntax with:

```bash
jq empty skills/helix-evidence-pipeline/contracts/*.json \
  skills/helix-evidence-pipeline/packages/*/*/package.json
```
