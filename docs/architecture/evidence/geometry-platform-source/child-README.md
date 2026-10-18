# Coherent source ownership evidence

This is an incremental implementation over reconstructed final288, not a
production retained-engine cutover. The reconstructed baseline is
`02cd98b5193c1c70b314fa106b0337438524db49`, based on
`8acd0715a5ad266cd57808b9889f6549fbf93631`. All 288 inherited source hashes were
verified against the supplied manifest with SHA256
`29cb0bc3971c14c78f0557309bf6e51b6a24c415f196490dea2f5a80b34a902d`.
`baseline-verification.json` retains that proof and fixture provenance.

`source-manifest.json` identifies the final incremental source, including the
semantic cache provenance correction. `prior-source-manifest.json` identifies
the earlier source used by native output controls and initial local checks.
Those earlier checks are not qualification of the later cache correction.
Final fleet requests compile the corrected source independently on PC/WSL;
remote fixture skips and results are recorded in `verification.json`.
The only source difference between the final manifest commit and the submitted
fleet source is clarification in the architecture document; every changed Rust
and package file was checked byte-identical to the submitted commit.

The source factory owns paired bytes/indexes, actual canonical native loads,
browser FromSource batches and appearance base sources. Opaque semantic cache
transfers retain bundle/revision provenance. Raw cache imports preserve their
trusted-input behavior but revoke source authentication. Appearance authored
rows use explicit trusted revisions, expiring prior contexts. Adoption cannot
authenticate a populated borrowed decoder. Direct early duplicate reads cannot
populate the factory's last-occurrence ID cache. See the Rust cache and owned
product tests for rejection before work, canonical same-source prewarming and
persistent worker-cache reuse.

Compatibility boundaries remain explicit: supplied native indexes, borrowed
contexts and legacy data-taking browser calls retain caller pairing
preconditions. Trusted authored/extension inputs, unit-scale arguments and the
canonical placement-memo writer contract do not certify arbitrary caller
computation. Existing custom processors may produce arbitrary geometry; source
ownership is not an oracle for extension correctness. The legacy cheap style
signature collision remains unchanged; the coherent path compares exact wires.

`abi.json` records the earlier independent baseline/candidate WASM comparison:
all 365 existing raw InitOutput fields and all five existing JS batch decoders
were unchanged; the additive source binding was the only new raw field.
The later cache correction adds no binding. Current rebuilt contract results
are recorded separately rather than relabeling that earlier ABI run.

`native-ab.json` contains five-iteration base/branch FZK and ISSUE129 native
output controls; `native-heavy.json` contains a bounded Holter control. Their
ordered fingerprints and mesh/vertex/triangle counts match on that earlier
source. Timing is HELD because concurrent build/test workloads contaminated
measurement. These native controls are not browser worker-pool performance
qualification. The fingerprints omit UVs/textures/instances/properties and
complete diagnostics. No final-source speed, memory or full-scene byte-identity
claim is made. Physical browser federation acceptance at one and N models,
including worker memory/timing and cache completion, remains unrun. The
canonical viewer load path was not replaced.

The default local workspace run on the earlier source failed at the inherited
positional-read ratchet's stale rows for `router/mapped_item.rs` and
`router/processing.rs`. Both files, the allowlist and gate are byte-identical to
the reconstructed baseline (`inherited-ratchet.json`). The geometry owner must
reconcile that inherited debt; this layer does not modify those files or raise
any ratchet allowance. Initial root TypeScript runs encountered a 10-second
`create` suite import-hook timeout; the serial-worker root run is separately
recorded. Logs retain failures as well as passing checks.

No parent target/source, other implementation worktree or immutable parent
evidence was modified. Fleet receipts retain their original host and source.
No SMLib production activation, broad router cache transaction, resource
admission implementation, PR, issue or publication is included.

The corrected source compiled on PC/WSL and passed all six new semantic-cache
cases, all five source-bundle cases, all five owned-source cases, the callback
contracts and appearance context tests. Workspace all-target Clippy passed with
`-D warnings`. The default workspace command stopped at the inherited ratchet.
The independently rebuilt WASM passed 102 contracts (four fixture-dependent
groups skipped) and five model-context tests (zero skips). Its committed type
surface remained unchanged. A normal-tool fetch of the five required IFC
fixtures was blocked before dispatch when PC SSH became unavailable and Pop's
ordinary job kind was disabled. That request has not been retried. These records
do not claim the skipped final-source fixture groups passed.

At handoff the preserved legacy root `pnpm test --concurrency=1
--env-mode=loose` run, with `VITEST_MAX_WORKERS=1`, is still active at
`/tmp/source-owner-ts-tests-worker1.log` (tool session 62616). The MCP suite
passed 738 tests with five skipped; create passed 1610 with 14 skipped; the
graph reached viewer build/tests. `legacy-root-test-inflight.log.gz` is explicitly
an in-flight log snapshot, not a final result. Package/app sources remain
byte-identical to the earlier source cohort, while its WASM runtime predates
the Rust semantic-cache correction. The separate final-source PC WASM checks
cover that correction; no full root TypeScript test pass is claimed.
