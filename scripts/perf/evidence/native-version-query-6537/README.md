<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->
# Native version-query admission evidence (#6537)

This qualifies one local, dependency-free canonical Cargo/probe startup guard.
It does **not** qualify hosted model runs, elapsed comparisons or performance.
The seven tested source files are pinned in [index.json](index.json); their base
is `9baab5249df8dbce2ae3f461ef9a95ba5d726f7e` (the parent native controller).
The source-only V4.1 freeze is historical; actual V4 validation follows it.

Normal execution retains a fixed 250 ms observation timer. Only the explicitly
named startup-control entrypoint uses 2 ms. Both refuse policy overrides before
spawning. These are nominal registrations, not guaranteed sampling intervals.
Resource floors, CPU/noise rules, fixed cohorts, raw logs and cleanup stay intact.

The archive preserves these separate outcomes:

- Hosted run **37167463547** refused its first sample: a real frozen `rustc -vV`
  child of admitted Cargo was treated as unknown work. No pairs completed.
- Local V2 retained 30 passing controls, genuine argv/hash inverse assertions
  and restoration, but the real 250 ms startup observed no version child.
- V3 retained 32 passing controls and a genuine timer-policy inverse. Its 2 ms
  startup observed the compiler; 19 of 20 predicates passed, but the child had
  disappeared before the final check after hashing. This remains **REFUSED**.
- V4.1/V4 retained **34 passes, zero failures/skips**. Two pinned-hash inverse
  controls and one final-PID-reuse inverse failed with genuine `ERR_ASSERTION`;
  the unchanged eight controls passed after byte-exact restoration.
- The single real V4 startup admitted a frozen compiler version child with
  **21 positive provenance predicates**: fresh common ancestry, directly admitted
  live parent, exact arguments, both post-open live process bindings, held regular
  executable FD sizes/inodes/hashes, live final parent and explicit final child
  PID absence. Cleanup, both raw pipes, holder exit, frozen-tool verification and
  owned temporary-crate removal completed. No retry followed this attempt.

Pinned FDs are closed on partial acquisition, callback failure and completion.
The final absent-PID disposition certifies a contemporaneous absence observation;
it does not record the grandchild's exit code. Missing, reused, reparented,
permission-limited, unobservable or contradictory records still refuse admission.
The known version command remains unchanged; no compiler wrapper or pause is used.

The independent root review has **17 checks** and includes exact raw log hashes:
`root-tooling/6537-native-version-child-root-review-v5.json`. Earlier historical
proposals and refusals remain verbatim. `manifest.json` names every original
member, byte count and SHA256; all downloaded artifact members are retained while
only the redundant original ZIP container is excluded. No IFC, executable binary
or package directory is archived. Source/code files are receipts, never executed.

Validate and extract to a **new** directory:

```sh
python3 scripts/perf/evidence/native-version-query-6537/safe-extract.py /tmp/native-version-query-review
```

This checks archive/member hashes, exact counts/sizes and safe file-only paths.
It establishes byte integrity, not a rerun of the compiler or performance protocol.
