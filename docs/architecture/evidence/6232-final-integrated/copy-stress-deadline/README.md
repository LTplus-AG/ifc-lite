# Deep Copy correctness deadline

The 5,000-level imported assembly control preserves every fixture, traversal, identity, relationship, native-mesh and displacement assertion. Only its explicit deadline changes from 120,000 to 300,000 milliseconds; production, global test deadlines and native geometry processing are unchanged. This is a finite correctness control, not a performance benchmark.

The original Copy CI job 111290828553 on `aade1f668f18c964dc905da5550c270954ef85a0` timed out at 192,607 milliseconds. The same unchanged test passed in 29,745 milliseconds in final-branch Node job 111290948940 on `527454446389e25f3792630dc7a87743e88da8e5`. These runner-sensitive observations justify a bounded per-test allowance without reducing the 5,000-level old-source RangeError oracle.

The repair `fc8e0b711ea9e911ad25a84a0b3139f8e07e3ec0` passes the six-file, 31-control Copy cohort through root Turbo with `--only --force`: zero skips, 22.93 seconds of tests, 27.642 seconds total. Actual runtime hashes were checked before and after: WASM `7d63d9bc94333f10c4044eac3f70bd86bf361b98659ff5e6cb1161def46f597b`, JS `4719403c55b6061b7ff3ba260ae45783c4db846cb70ccd70ac51d5b03d87373d`. The complete source-labelled logs and hashes are retained in `receipts.json`; successful old CI is not represented as qualification of a new head.

Production remains identical to the source-bound browser receipts in `../parent-boundary-forward/`; this test-only change requires fresh current-head CI and review before merging.
