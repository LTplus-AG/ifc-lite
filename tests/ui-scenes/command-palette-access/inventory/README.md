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

The source inventory itself makes no runtime claim. Executed-route bindings and
`historical-child-bindings.jsonl` carry separately attributed evidence;
`remaining-access.md` retains missing parent/body and child joins. Historical
composition is not a current end-to-end pass. The general UX hillclimb's accepted
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
adds 72 records / 490 sites. The final shared-control review adds the remaining
78 component records / 340 sites. Every original component now has a scoped source
review, but some consumer chains remain explicitly unresolved. This is source
accounting only. The conditional error-report launcher found in earlier reports
is now implemented in the R2 candidate; its behavioral tests remain unexecuted.

Remaining qualification includes shared HUD/analysis producer branches, installed
extension contributions, popup policy, role/provider conditions and downstream
mutation/export results. A complete count cannot clear those unknowns. The
coordinator must bind actual canonical destinations and behavior receipts before
claiming complete access.

## Qualified execution overlay

[Executed route bindings](executed-route-bindings.jsonl) associate actual passing
assertions with specific palette destinations, fixture contexts and original IDs.
[Provenance](executed-route-provenance.json) pins the executed source, root command,
log hashes and 382-test focused receipt. This overlay preserves every original
source record and its historical UNRUN verdict; it does not turn component-level
links into proof for all child controls. The 48 bindings are evidence relations,
not a feature count or a completeness percentage. Full-suite, corrected GPU
extension output, outstanding route witnesses and R2 acceptance remain pending.
