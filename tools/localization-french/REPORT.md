> Historical checkpoint evidence. See RELEASE.md for integration scope and pending gates.

Current Settings-based acceptance is pending after the rebase. Historical measurements and browser runs below retain their original source identities and do not establish current-head acceptance.

# French locale status

French ships through the existing lazy locale discovery with 158 bounded feature
modules, covering all 10,607 English keys including lazy features. Object audit:
zero missing/unknown keys, zero catalogue problems, 536 value-pinned identical
exceptions. No English-copy fallback is claimed as completion. The largest
feature module has 392 lines. Use Settings → General → Language → Français; fr-CH negotiation, persistence and
HTML language use the existing activation path. No new UI/framework.

## Meaning and maintenance

ACCEPTANCE.md records glossary and boundaries; i18n/README.md describes updates.
English/French messages and placeholders must change together. Existing viewer
Turbo tests enforce catalogue completeness, pinned exceptions, startup ownership
of every key before lazy English registration, French Intl categories at
0/0.5/1/1.5/2/2.5/1,000,000, formatting, negotiation/persistence and IDS sync.
The workflow verdict regression rejects fatal errors, failed checks and page
errors from either page. Semantic review and independent recheck accepted round
2 repairs. This is technical model review, not native-speaker approval.

## Validation results

- Local admitted original `6e2fc76c-3124-4fb5-9e5d-a3c4c214146c`, source
  abeb878ee8 through fd5eaf6277 (source changed while the graph ran): root
  `pnpm typecheck` passed, 134/134 Turbo tasks plus root tail; then
  `TEST_PATTERN="src/i18n/.*test" pnpm test --filter=@ifc-lite/viewer` passed:
  66 tests, zero failures/skips, 59/59 Turbo tasks including the viewer build.
  All eight added French tests ran. Final stable-source validation below is
  required because the original source receipt changed during integration.
- Clean committed-source original fleet request
  `auto-b952f0c6fcbe494889f791707b35130b`, source fd5eaf6277: frozen install,
  root typecheck, same root Turbo test selection, pre-handoff with actual German
  parent base f6b4dc4521, root lint. Routed to Pop, worker 8d3f5f58-9650-4fcc-aa4c-d5cf4e086532;
  completed **exit 0**, with unchanged clean source and verified published
  evidence. Root typecheck (134 tasks plus tail), selected tests (66 passed,
  zero skipped), all 13 pre-handoff gates and root lint passed. Lint reported
  existing warnings, zero errors across 12,222 files. No replay/cancellation.
  Receipt: /home/louistrue/build-workers/worker-state/jobs/8d3f5f58-9650-4fcc-aa4c-d5cf4e086532/receipt.json.
- Exact dry-run inspected @ifc-lite/viewer#test command and TEST_PATTERN forwarding.
- Direct lightweight module size, test wiring, i18n literal ratchet and whitespace
  checks and full source-text checker passed.
- Local pre-handoff after both commits stops at clean-tree preflight: protected
  untracked campaigns and parent-owned German edits are deliberately preserved.
- Preview service original dc76c1b4-fc1d-4ca4-881d-cb08ab6eda24 on port 5189
  served the final build and was stopped after acceptance via its verified owner.
  Real GPU workflow passed all ten checks with no page errors/skips; WORKFLOW.md
  records exact screenshots, hashes, failures and observed limitations.

## Boundaries and preservation

The original German request auto-0fce1bb98b224ca5af396a9d93a374d4 was
inspected: failed exit 1 on PC, verified published evidence, unchanged source
aea79e9a1c. Its exact failing gate is not inferred from status. Parent owns its
reconciliation; never cancelled/rerouted/replayed here. German source/review/report changes are
parent-owned and excluded from French staging. Both campaign trees remain
byte-identical to the thread-start inventory; preservation.json records the
compact result. No push/PR/merge. No Rust or full viewer/monorepo test suite claim.
Legacy uncatalogued theme/ViewCube/toast/template/extension content is outside
catalogue completeness; report observed runtime limitations in WORKFLOW.md.

Dependency build logs explicitly skip the IFCX hello-wall verifier because four
external IFCX fixtures are absent. No such fixture is needed for the committed
IFC/IDS browser workflow. Rust tests/clippy, full viewer and full monorepo tests
are not claimed. Local graph cache hits are accepted as cache results, not new
compiler execution; browser runtime provenance is recorded by SHA256 separately.

## Acceptance and stop decision

Stop after two of at most eight improvement rounds: full catalogue ownership,
independently accepted semantic repairs, local root graph and real hardware
workflow demonstrate functional acceptance of fd5eaf6277. Its original
clean-source aggregate subsequently completed successfully, removing that
checkpoint's queue blocker. Later parent-owned French repairs and Italian work
are separate source revisions: this receipt does not certify their current HEAD.
The browser evidence above applies to the recorded fd5eaf6277 build.

Browser evidence: real house, 14 meshes; exact selected GlobalId; actual
measurement and cutting plane; French IDS requirements and downloaded report
(3 specifications, 11 entities, 8 passed/3 failed); 1600×1000 and 390×844 screens;
URL, storage/reload, en switch and fresh fr-CH negotiation. Both pages collect
runtime errors. Built French chunk SHA256:
54a7a9f9ce2da90a87fbb720e7e4b5bcbb18ccc0fa12427acc8a4ea50dec182a.
Built/installed WASM SHA256:
99d9681387e12ac8a04731eefbd03bc0599e23236803d447d22c8b5604c255b4.
Privacy notice obstructs much of the narrow lower viewport; legacy English
labels and local analytics 404s remain explicitly scoped in WORKFLOW.md.
