<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Selectable validation definitions (#6567)

Captured source: `e0ca60802e1db9c03f7cf01f924cdae9392b98e8`, based on main `7d33d8cd6917c6a0df5d1b3e6aca741e554c8ba7`. This evidence successor changes no production, tests or release metadata.

The actual browser capture uses owned-profile Linux Chrome 153.0.8010.36 against the normal root `pnpm dev` viewer. The primary file input loads the committed SketchUp 2024 IFC sample (444 entities). The two-model cohort adds its real revision through the canonical `loadDemoRevB` helper (474 entities). Input SHA-256 values, registered model identities and saved reports are in [facts.json.gz](facts.json.gz).

Both cohorts import two Information rule sets through the file input, select the original, copy and edit it, then delete the copy. Assertions verify distinct UUIDs, unchanged original source and frozen saved report history, and deliberate current-report invalidation. Completed rule downloads are reparsed by the existing canonical importer and equal the original source. The same operations on two IDS documents preserve exact XML; the completed original IDS downloads match the committed input SHA-256. Reloading the same browser profiles restores all four independent definitions, their active UUIDs and both saved reports; loading the real models again retains that history.

The two-model cohort also imports a **declared generated quota control**: the original XML with a renamed title and a legal 6 MiB XML comment. Chrome's actual `localStorage.setItem` refuses it because the browser quota is exceeded. [The screenshot](2-quota-warning.png) shows the visible warning. The new source remains usable and its completed download matches all 6,293,379 input bytes. Prior stored library bytes remain unchanged; reload restores those four prior definitions and both reports. This is an actual browser quota failure, not a simulated storage exception or a claim that the derivative is the original fixture.

The supplied IDS already has one audit error; the screenshot and facts retain it. The federated model also reports its existing reprojection warning. Software WebGPU produces one fragment-shader page error, preserved in the facts. This archive proves validation UI and data behavior; it makes no hardware 3D or performance claim. The floating panel layout and second-model helper are declared harness setup; import, selection, copying, editing, deletion, validation, saving and downloads use actual DOM controls.

Each cohort observes worker WASM response URL/status and, after all user operations, separately retrieves the same served resource: 9,472,263 bytes, SHA-256 `039415545e2448ce8b1e40b14306524ee60cff29dabd97448080ac0d9e170610`. This is a served-resource byte witness, not the original worker response body or GPU upload evidence. Both owned browser contexts and the development server were closed after capture.

## Qualification

The final source passed exact plain root typecheck (109 tasks, 3,258 test files), full root build (61 tasks), root lint (8,156 files, zero errors; two untouched example warnings), API snapshot (9,173 exports), and documentation samples (428 compiled, 12 existing skipped). MPL, module-size, test wiring, source-assertion, Changesets, generated-docs and package-readme gates passed. The viewer minor changeset was generated through the actual Changesets CLI.

The 57 affected tests (39 new, 18 unchanged) passed without skips on source `9cc5f7b3d3c4389acd5477b49873ab292481025c`; all 15 source/test files are byte-identical in the final disjoint main integration. Final-main official inverses proved the feature (4 passed → 4 assertion failures), shared import/reset ownership (18 passed → 7 passed, 11 assertion failures), and absent-storage warning (17 passed → 12 passed, 5 assertion failures). Every inverse verified restoration. [The complete qualification record](final-qualification.json.gz) includes baseline attribution, excluded attempts and hashes of actual scratch logs. Fresh full PR source CI and reviewer feedback remain required before merge.

## Reproduce and inspect

Run `pnpm dev --host 127.0.0.1 --port 52725` from the captured source, then `node docs/architecture/evidence/6567-validation-definition-library/browser-capture.cjs <worktree> <output-directory> 52725`. The harness requires the repository's Playwright dependency and `/usr/bin/google-chrome`; use fresh output/profile directories.

Archives are lossless. Use `gzip -dc facts.json.gz`, `gzip -dc final-qualification.json.gz`, or `gzip -dc 2-quota-control.ids.gz > quota-control.ids`. [The artifact manifest](artifact-manifest.json) records every archived and original byte count and SHA-256, including both original rules downloads. No functional source or test is compacted into an archive.
