# Complete-feature source matrix — #8947

This is the source inventory for the **separate feature-access hillclimb**. It
preserves 624 component identities, 3,994 original callback anchors and 189
indirect/display candidates. These are accounting counts, not distinct features,
behavior coverage percentages or acceptance scores.

`source-controls.jsonl` has one JSON record per original identity. Each keeps its
original anchors and most recent source review, including palette destinations,
ordered child controls, prerequisites, public handler boundaries, unresolved
chains and finite behavior oracles where established. `reviewKind` distinguishes
partial family tracing from focused reviews. A focused review can still contain
an unresolved control; inspect its qualifications. A parent panel alone earns no
child-action coverage.

Every runtime verdict remains **UNRUN**. The general UX hillclimb's accepted
screenshots and keyboard tests do not certify these feature routes. Model-loaded,
unloaded, selected, unselected, read-only, provider and extension contexts must be
bound to actual scenario receipts before acceptance. Opening a complex tool is
valid only when its downstream controls reach the actual flow with prerequisites
explained. Source excerpts are not test assertions.

`provenance.json` pins every original report by SHA256 and reviewed source commit.
Those commits intentionally differ: several reports found omissions that later
implementation fixes. Consequently their gap text is historical evidence, not an
assertion that the current candidate still has the defect. Reconcile changed
routes and append concrete execution receipts before marking any row accepted.
Never silently delete an awkward identity or convert an unknown to display-only.

The compact matrix omits redundant source excerpts and internal call-graph dumps;
it preserves paths, public boundaries, original anchors and unresolved findings.
Full original reports remain coordinator evidence. To regenerate from that report
directory, run from the repository root:

```sh
node tests/ui-scenes/command-palette-access/update-inventory.mjs REPORT_DIRECTORY
```

The updater checks identity and original-anchor accounting. It is a preparation
tool, not a CI or acceptance gate, and never promotes a source report to runtime
proof. Update its ordered report list when a fresh focused review replaces an
older family trace, retaining the original identity and anchors.

The focused Assistant/Semantic review traces 60 records / 392 original sites.
Its reported “missing shortcuts” are discoverability gaps: the real panel paths
reach those child controls subject to model/provider/proposal prerequisites. They
are not 60 missing tools, and adding unconditional proposal execution would be
incorrect. The appearance/settings review adds 69 records / 499 sites, and drawing/hierarchy
adds 72 records / 490 sites. 78 component records still have only partial family
tracing. These source reviews identify the conditional error-report launcher as
a remaining palette gap; their behavioral oracles remain unexecuted.
