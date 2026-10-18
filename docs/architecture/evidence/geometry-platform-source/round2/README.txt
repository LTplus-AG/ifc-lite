Round-2 coherent source preservation delivery

Own checkout: /home/louistrue/.t3/worktrees/ifc-lite/t3-a360cbd1
Prepared parent: 772522f9df7a06d5287c1e9934055206fd464866
Applied source baseline: 17d120a3e898dbc2eb2046716b04afcca5ae46a2
Initial tested preservation correction: 307c7c60ee (full hash in verification.json)
Correction-only head: c1ce97c1ac4942040a38f7c244ce32629e42d4ab
Final head including canonical declaration: b676f94f4a67ca99d29efd43ca691eb746046c37

correction.patch is ONLY baseline17d120a3-to-c1ce97c1ac corrections.
It restores cached native layer scanning and installs the completed bundle's
existing index in the populated prepass decoder without source authentication.
Fresh workers still use source.decoder(). No second scan/hash/clone per job.
It adds same-class/cross-class duplicate and cache-transfer invariants.
The fixture-only appearance setup fix uses the actual production factory,
retains every original geometry assertion, and checks trusted authored revision.
That last test-only setup migration has NOT been rerun: admission refused.

generated-declarations.patch is separate: regenerated via scripts/build-wasm.sh.
combined-source.patch is prepared-parent772522-to-finalb676f94 source output.
combined-source-manifest.json hashes all 53 combined changed paths.
Both the correction and combined patches were applied in temporary Git indexes
and reproduced their exact expected commit trees. No parent checkout was edited.
Do NOT cherry-pick the inherited original whole implementation checkpoint.

Evidence:
- Focused processing preservation tests: 3 passed.
- Core cache provenance/overflow/destination invariants: 8 passed.
- pnpm fixtures: all 182 manifest entries fetched, no errors.
- Full cargo test --workspace --no-fail-fast -- --nocapture:
  5773 passed, 1 failed, 47 ignored across 377 groups.
  Sole failure is the appearance fixture test's stale unbound setup, corrected
  at c1ce97c1ac but its rerun was not admitted. All other targets and ratchets passed.
- cargo clippy --workspace --all-targets -- -D warnings: passed at 307c7c60ee.
- bash scripts/build-wasm.sh: passed, runtime rebuilt, declaration regenerated.
- pnpm test:wasm-contract: failed BEFORE TESTS, missing renderer/dist/scene.js.
- Final affected-library/Clippy and root-Turbo dependency/boundary graph prepared
  in verify-final.sh and verify-boundary.sh. Admission refused BEFORE execution:
  disk 204.3 GiB free; require 316 GiB (reserve plus scratch; existing jobs continue).
  Receipt 7ef8d1c4-6891-4465-a485-fb9384450d14. No guard bypass or retry.

commands.tsv records exact executed commands/times/exits. verification.json and
three copied worker receipts preserve host/source identity. workspace-skips.log
records ignored and optional external asset/adapter skips. No optional engine
activation, performance claim, or physical-browser qualification.
Unchanged old TS session 62616 and unknown parent requests were untouched.

Parent update fb913d3a5c was inspected read-only; no rebase or port performed.
The correction-only layer has no overlapping paths. The combined layer overlaps
four paths listed in integration-overlap.json. A temporary-index application
check against fb913d3a5c fails at element.rs's test-module append hunk; see
parent-application-check.json. Preserve both parent and source test declarations.
Other overlapping context/session hunks require semantic integration review.
Parent's new numerical sink and terminal-audit requirements remain parent scope;
this delivery does not qualify that integrated BooleanProgram.
