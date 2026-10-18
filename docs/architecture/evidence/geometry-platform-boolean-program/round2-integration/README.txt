IMPLEMENTED; FINAL SOURCE UNQUALIFIED / CAPACITY BLOCKED

Own app checkout:
/home/louistrue/.t3/worktrees/ifc-lite/t3-106818eb
Branch: t3/boolean-program-preservation-fixes
Parent: 288932a2474c2e78692a8403c345bb1d273b7c71
Original BooleanProgram + parent layers baseline:
840ae6c70f45972287543a6327ed0f16c67b4b20
Correction checkpoint:
a3cefb1b61dc51ca5ae227c381f0fdd063231f1b

Integration:
- Parent already has round one: apply corrections.patch only.
- Parent matches supplied 288932a247 product/layers: apply
  combined-boolean-program.patch only (includes original + corrections).
- Do not apply both patches. Do not cherry-pick the original child's inherited
  overlay. Root program/mod.rs only adds mod boolean beside parent layers.
- Neither the parent checkout nor the immutable original child was edited.

Evidence:
source-manifest.json: parent/original/candidate SHA256s for every changed/deleted
path, patch hashes, inherited layer context and final commit/tree.
source-tree.txt: complete committed tracked tree object listing.
qualification.json: exact status, tests added, checks not run, remaining objections.
capacity-receipts.json + pop-disk-guard-snapshot.json: actual read-only capacity.
source-audit.txt: precise allocation and restoration mechanism audit.
diff-check.txt: empty successful git diff --check output (not runtime evidence).
commands.json: pinned validation commands NOT SUBMITTED. Revalidate capacity
before any submission; do not automatically retry unknown outcomes.

No final compiled-source receipt exists. The old 1531-test dirty iteration does
not qualify this checkpoint, these corrections, or these tests. No new heavy
job was submitted to unchanged refused/full capacity. No foreign cleanup, nested
admission, unknown-outcome retry, external-original-project reference or new
loader/engine path was introduced. Mandatory native/Clippy/WASM/corpus validation
and actual whole-pool performance qualification remain pending.
