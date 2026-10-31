# Real-authoring fixture qualification — Refs #7955

The seven implementation commits through `1fc097466c` are inherited from the
interrupted agent. This continuation merged main `417877fe65` normally, producing
`14a8e45b55392eb49d23bfb3f29bb88a1ce6d4fe`. That includes the omitted-Axis2
repair `c7ddb2b9a0` and the landed M6/M10 work. No production source, default
output implementation, fixture bytes or frozen tolerances change in this PR.

## Fixture provenance and size review

This PR registers existing tracked files. It adds no IFC bytes and no new
distribution of model files; no IFC payload is added or uploaded. Their combined size is 369,609 bytes, each below 1 MiB and
GitHub's 100 MiB blob limit. This is a payload-size check, not a performance claim.

| Fixture | Bytes | SHA-256 | Provenance / terms |
| --- | ---: | --- | --- |
| SketchUp `apps/viewer/public/samples/building-architecture.ifc` | 225635 | `3ff9b10bd00c7b96dded51e7ca5a6b69efbea38b049adcdd05fcd247de7e70d5` | buildingSMART Certification-datasets; CC-BY-4.0, credit buildingSMART International Ltd. Existing pinned evidence: `tests/ai-eval/native/sketchup-licence-provenance.json`. |
| Bonsai `apps/viewer/public/samples/hello-wall.ifc` | 79592 | `0ab20f4ea355ea9aa4fade7264b97ee9f9929addfa3961b2437c4381bd674014` | Byte-identical to [IFC5 example](https://github.com/buildingSMART/IFC5-development/blob/1a63082ada967c683cfacee2005f8f749c8e1b79/examples/Hello%20Wall/hello-wall.ifc). The [README](https://github.com/buildingSMART/IFC5-development/blob/1a63082ada967c683cfacee2005f8f749c8e1b79/README.md) permits educational/testing use and asks not to create derivatives. No SPDX model licence is declared; the viewer MIT licence is not applied to the model. The tests generate exact/retained OBJ and viewer-derived artifacts. Permission for those derivatives has not been established; maintainer decision remains open. |
| Revit `rust/geometry/tests/fixtures/issue_098_wall_V5C.ifc` | 64382 | `b73f7ee743824ae800e0d494a7bcd444c24cecb03aa0c5d837597b490f05b597` | Existing extracted fixture introduced in `84cd5aa3b5`, from ara3d/web-ifc ISSUE_098, exporter Revit 2022. The [ara3d data manifest](https://github.com/ara3d/3d-format-shootout/blob/6aafe2dc7c26f4f972773cacef9ca81f9f39085e/data/manifest.json) directs users to check per-file rights before redistribution. A model-specific licence grant has not been established by this review. Do not infer one from ara3d's MIT code licence. |

No new completed human privacy/licence approval is asserted. The existing
SketchUp record explicitly leaves those approvals pending. Revit model rights
remain an open, pre-existing limitation for the maintainer; this PR does not
resolve that existing distribution. Existing tracked IFC bytes do not establish
permission for generated derivatives. **Maintainer decision required:** confirm
whether the Bonsai terms cover generated OBJ/viewer artifacts (with recorded
permission), or remove/replace derivative-producing Bonsai scenarios. No such
permission or human privacy/licence approval is claimed by this agent.

## Measured coverage after merging main

The fresh Pop run measured the 35 registered candidates below. Each product's
identity, publication status and refusal code was compared with the branch's
previously committed baseline, not just the aggregate counts:

| Fixture | Candidates | Previous published / refused | Fresh published / refused | Product deltas |
| --- | ---: | ---: | ---: | ---: |
| SketchUp building-architecture | 14 | 0 / 14 | 0 / 14 | 0 |
| Bonsai hello-wall | 6 | 3 / 3 | 3 / 3 | 0 |
| Revit V5C | 15 | 7 / 8 | 7 / 8 | 0 |
| Total | 35 | 10 / 25 | 10 / 25 | 0 |

Measured refusal causes:

- SketchUp: 14 refused (`operation_unsupported`). These products
  are outside this branch's retained adapter scope; an all-refused CLI export
  must fail without writing OBJ, and the viewer must retain identities/refusals.
- Bonsai: 3 published, 3 refused (`operation_unsupported`).
- Revit V5C: 7 published, 7 refused (`operation_unsupported`), and the wall with
  faceted reveal openings refused (`opening_unsupported`).

These are measured outcomes from the merged-source re-bless, not unverified
counts carried over from the previous agent.
Across all eleven manifest files: **zero changed data rows**, including the
base manifest (143 candidates, 119 published). Total: 406 candidates,
247 published, 159 refused. No added/removed candidates, changed refusal codes,
or published-to-refused transitions. The generator removed comments from
m10/m11-i/m11-n only; those comment removals were discarded.
`rebless.json` records the per-manifest results. No tolerance was changed.

Verified locally on merged source: 15 helper/metrics/tolerance tests pass with
zero skips; explicit-base pre-handoff reports **OBSERVED**, with restored
witnesses green. Available gates pass. Skipped: source-text assertions
(TypeScript absent), workflow report paths (YAML absent), default viewer
(bundle absent). These skips do not establish engine or browser acceptance.

## Pop receipts

Fresh native re-bless: automatic request
`auto-4ebff5cd14e04c56991fd68edb231656`, worker job
`9dc22272-baf0-421a-ba85-80c98c4c6e15`; original receipt under
`worker-state/jobs/9dc22272-baf0-421a-ba85-80c98c4c6e15/receipt.json`.
It targets merged source `14a8e45b55`, builds a fresh native worker and uses a
private Cargo target that its script deletes afterwards. Exit 0; immutable evidence publication verified. CMake's source directory and
every Cargo Compiling path name that checkout. Worker SHA-256:
`b769e9483ba3d2ba33e4ff6917b15358c33e9a09fcf730fee9e865e8c8653460`.
The fresh outputs were read from
`landing-perf/real-fixtures/rebase/14a8e45b55/blessed/` and
`landing-perf/real-fixtures/rebase/14a8e45b55/coverage-bless/`; the log records
the actual `retained_compare --committed --bless` invocation. This was not a
skip or an old-worker reuse. The private Cargo target is confirmed absent.
Native comparison reports no
violations, universe mismatch or skipped models.

The separate full engine/browser lane preflight was refused before submission
(request `auto-affdd5bc9dd942e397c784784137579e`, capacity guard exit 78,
fleet wrapper exit 69). It is not an active or successful execution receipt.
Earlier successful lane logs at `1fc097466c` are inherited and do not qualify
the merged head.

The subsequent full engine/browser lane ran on Pop, request
`auto-d1d350c55ca2493aacf9855e10cab768`, job
`2f28bf24-5a6e-4e72-88d7-2f55d665d640`, source `c9b69f3a01`.
Its source differs from the re-bless only by these documentation notes.
Fresh native and Emscripten builds, all 5 native CTests, native gate, real-kernel,
CLI/native comparison, all 3 real-authoring tests, all 5 helper tests, Chromium
corpus parity and all 18 viewer e2e tests pass. No test skips. The private Cargo
target and both CMake build trees are deleted. `validation.json` records steps,
CLI witnesses and sublog hashes.

That combined receipt exits 1 solely because the final pre-handoff correctly
rejects its opt-in viewer bundle as not retained-free. All other gates pass,
including OBSERVED with restored witnesses green. This wrapper result is not
reported as an overall green run.

A separate **default** viewer build and post-commit pre-handoff on `f60a071752`
pass **all 12 gates, with no skips** (986 output files checked retained-free).
Request `auto-a1bf304b7e724ebd9b87dae4466ec23e`, receipt
`worker-state/jobs/60013c10-d095-485b-b7f9-19010e1d626b/receipt.json`, exit 0,
source unchanged, evidence publication verified. This supersedes the local
missing-dependency/bundle skips above. The first default wrapper omitted
installation and failed before compilation (`turbo: not found`), original
receipt `worker-state/jobs/60a7f812-4921-4e2d-a05e-82b3bd573ddc/receipt.json`.
It was corrected by installing dependencies explicitly, not by weakening gates.

All changes after the tested source are qualification documentation/evidence
only. The seven implementation commits were inherited; this continuation
independently verified the merged native coverage, actual CLI exports, actual
browser parity/viewer behavior, and default retained-free build described here.

The combined lane's execution receipt is finalized (source unchanged), but its
storage status remains `evidence_pending`. Supported `storage job-recover-capture`
refused with `original finalization requires owner reconciliation`. The refusal
was respected: no receipt edits, lock removals or project-command replay.
Compact results and sublog hashes are committed here; original logs remain at
`landing-perf/real-fixtures/finish/lane-c9b69f3a01`. Native re-bless and separate
default-build evidence publication are verified. Final local post-evidence
pre-handoff again reports OBSERVED with restored witnesses green; its three
missing dependency/bundle skips remain explicitly separate from the successful
Pop default-build pre-handoff.

## Scenario witness enforcement follow-up

The review follow-up adds post-assertion records for every new CLI/viewer
scenario, a scoped witness registry, and checks captured CLI/viewer logs in the
native-adapter lane. Five gate regression tests pass; the missing-witness
mutation and the original helper oracle both report OBSERVED. See
`../real-fixture-witnesses/README.md` for the filtering invariant, explicit skips
actual full-log, grep, test-level shard and CLI-filter validation receipts. This follow-up changes no
fixture bytes, counts, tolerances or runtime production source.

## Comparison proof after review

The Revit built-CLI scenario now selects the registered V5C fixture and requires
`cli-real-revit-v5c`; the old wall-W witness cannot satisfy it. Every retained
publication must have an exact OBJ counterpart, including curved products;
absence is an assertion failure, not a diagnostic skip.

The geometric metrics are explicitly a CLI/native transport-consistency check.
Linear CLI volume must match native retained volume under the frozen linear
allowance plus OBJ quantisation; its additional exact-side volume/bbox envelope
is native-derived. This cannot detect a defect shared by native and CLI retained
geometry, and is not independent proof of geometric correctness. Earlier
validation.json results are historical runs on the named source (including the
old wall-W selection); final labelled native-adapter CI must qualify V5C.
