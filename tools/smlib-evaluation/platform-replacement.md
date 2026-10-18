<!-- SPDX-License-Identifier: MPL-2.0 -->
# Geometry platform charter

The target is one geometry platform that preserves every supported capability,
including IFC-Lite's exact arithmetic engine, and adds retained curved BRep
modeling through NVIDIA SMLib. The detailed plan is
[implementation-design.md](implementation-design.md).

This supersedes the earlier proposal to delete the exact kernel and universally
replace solid operations with SMLib. Exact polyhedral arithmetic and tolerance-
based curved BRep modeling provide different guarantees; both have permanent
responsibilities in the proposed architecture.

## Scope

- One Rust-owned geometry document, extending existing analytic definitions and
  occurrences, with explicit representations, revisions and operation contracts.
- One IFC interpretation, placement, appearance and diagnostic policy shared by
  browser, server, CLI, SDK, Python and embedded FFI consumers.
- Existing exact predicates and polyhedral operations retained with their tests
  and determinism guarantees; SMLib adds retained curved geometry and operations.
- Explicit, validated conversion between representations. No failure-driven
  switching that silently changes exactness or drops curved geometry.
- Shared lifecycle for modeling, display meshes, editing, queries and exports.
- USD mesh interoperability preserved; retained BRep interchange and a versioned
  IFCX extension designed alongside composition, identity and appearance.

## Delivery

Build the complete architecture on an integration branch, with reviewable stacked
changes and a coherent production cutover. Start by moving existing exact behavior
behind the new document/service, which separates architectural regressions from
new-kernel differences. Then integrate SMLib, all consumers and interchange.

Cutover requires a capability ledger with evidence for every preserved contract,
real authoring-tool models, differential geometry checks, existing exact arithmetic
oracles, native/browser lifecycle and packaging tests, and full-pipeline performance
and memory measurements. No unexplained capability loss is accepted.

Delete superseded orchestration, duplicate interpretations and proven redundant
repairs. Keep the exact kernel and numerical routines that still serve supported
contracts. The maintainability win is shared semantics and clear ownership, not
maximizing deletion regardless of guarantees.

## Current evidence

The [evaluation](README.md) records native/browser smoke tests against known
primitive and boolean invariants. It does not prove direct IFC-to-SMLib conversion, complete coverage,
face provenance, topology correctness, native worker throughput or browser BRep
interchange. Upstream ownership/measurement defects and unqualified
tessellation behavior are explicit qualification work. No production replacement has been implemented.
