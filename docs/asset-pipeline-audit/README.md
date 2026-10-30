# RigCheck Asset Pipeline Audit

> Read-only audit of invasion-godot (3d-migration @ 1f1b2a4) and rigchecks-3d (main @ f8c347a), as of Oct 30, 2026. The foundation is solid and safe. What's missing is lineage, lifecycle and rollback, and all of that can be added on top of the current system.

**Status:** documentation only. Nothing in this folder has been implemented, deployed or applied to the asset library. Intended for Opus to implement **after the owner (Antonio) reviews and approves** the plan. Promotion, deletion and replacement of canonical assets still require explicit human approval.

Sources audited: pizzarolls510/invasion-godot (3d-migration @ 1f1b2a4) and pizzarolls510/rigchecks-3d (main @ f8c347a), as of Oct 30, 2026.

## Files

1. [01-audit-findings.md](01-audit-findings.md): executive summary, findings by question, implemented/partial/missing, current library, library problems, prioritized recommendations, verdict, design note.
2. [02-provenance-and-lineage.md](02-provenance-and-lineage.md): Part A provenance of r_a86fda1a3ac3475a, Plan v1 (superseded) with its rollout and the owner's answered decisions, lineage investigation results and identity procedure.
3. [03-implementation-spec.md](03-implementation-spec.md): final implementation plan: architecture (mermaid), files and functions with line refs, data schemas, migration, API and job types, agent authentication, safeguards, tests and acceptance criteria, phased rollout, risks/effort/open questions, and what could not be verified.

## Contents

- [Executive summary](01-audit-findings.md#executive-summary)
- [Findings by question](01-audit-findings.md#findings-by-question)
- [Implemented, partial, missing](01-audit-findings.md#implemented-partial-missing)
- [Current library](01-audit-findings.md#current-library)
- [Library problems](01-audit-findings.md#library-problems)
- [Prioritized recommendations](01-audit-findings.md#prioritized-recommendations)
- [Verdict](01-audit-findings.md#verdict)
- [Design note: toward an autonomous pipeline](01-audit-findings.md#design-note-toward-an-autonomous-pipeline)
- [Part A: provenance of r_a86fda1a3ac3475a](02-provenance-and-lineage.md#part-a-provenance-of-r_a86fda1a3ac3475a)
- [Plan v1 (superseded)](02-provenance-and-lineage.md#plan-v1-superseded)
- [Plan v1: phased rollout (superseded)](02-provenance-and-lineage.md#plan-v1-phased-rollout-superseded)
- [Plan v1: open decisions (answered Oct 30)](02-provenance-and-lineage.md#plan-v1-open-decisions-answered-oct-30)
- [Lineage investigation results](02-provenance-and-lineage.md#lineage-investigation-results)
- [Final implementation plan](03-implementation-spec.md#final-implementation-plan)
  - [1. Architecture: current vs target](03-implementation-spec.md#1-architecture-current-vs-target)
  - [2. Files and functions to change](03-implementation-spec.md#2-files-and-functions-to-change)
  - [3. Data schemas](03-implementation-spec.md#3-data-schemas)
  - [4. Migration](03-implementation-spec.md#4-migration)
  - [5. API and job types](03-implementation-spec.md#5-api-and-job-types)
  - [6. Agent authentication](03-implementation-spec.md#6-agent-authentication)
  - [7. Safeguards](03-implementation-spec.md#7-safeguards)
  - [8. Tests and acceptance criteria](03-implementation-spec.md#8-tests-and-acceptance-criteria)
  - [9. Phased rollout](03-implementation-spec.md#9-phased-rollout)
  - [10. Risks, effort, open questions](03-implementation-spec.md#10-risks-effort-open-questions)
- [What I could not verify](03-implementation-spec.md#what-i-could-not-verify)
