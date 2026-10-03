<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Standalone live GPU input-byte control (#6537)

The corrected standalone control is **QUALIFIED** at literal source
`0c2a5e3222ac809d91d924bd9016a1bd9ed2b9f2` in
[run 37161606551](https://github.com/LTplus-AG/ifc-lite/actions/runs/37161606551).
The independent Python audit passes 137 checks with no findings. This evidence-only
layer changes no measured controller, renderer, caller, comparator or text guard.

Four actual readbacks match independent seeded bytes: vertex rows, a uniform
binding boundary, full RGBA atlas including alpha, and an atlas subrectangle.
Original source usages40/72/22 remain unchanged. Five complete shader compilation
records have no diagnostics. Legal augmented negative sources44/23 are observed
and refused by the exact-usage policy. The actual error ledgers are empty; owned
browser closure, all eleven process witnesses, both full log drains and final
source verification complete. Final device loss is deliberate owned destruction.

This qualifies the standalone synthetic input-byte extractor only. It establishes
no IFC annotation completeness, full glyph/atlas/frame readiness, draw bindings,
rendered pixels, comparator eligibility or performance. Tiled reads are not atomic.
Caller-retained outputs, driver caches and source memory are outside the helper's
accounted payload bound; no physical memory peak was measured. Declared source
inputs are not whole dependency/machine closure. Remote executable hashes and
process ownership are observed witnesses, not rehashed after runner termination.

## Retained predecessor and corrections

[Run 37161075655](https://github.com/LTplus-AG/ifc-lite/actions/runs/37161075655)
at `dfd4dcc3e590c9eeacd420a373f9fb5d5ae4ec0b` remains **REFUSED**. Its negative
fixture created invalid MAP_READ|COPY_DST|VERTEX41; Chrome's actual validation
warning and fatal uncaptured error are retained. All four preceding readbacks
matched bytes, but 135 diagnostic audit checks do not convert this to qualification.
The successor corrects only the legal negative fixture/observed descriptor checks
and retains GPU error type/message. Fatal error/cleanup guards remain strict.

An earlier dispatch API422 rejected a literal SHA before any run existed. The
authorized branch-ref dispatch was fenced before/after/end to each literal SHA,
and each owned run's head matched. That preflight refusal is distinct from the
GPU refusal. Original v4 packet historical “no install/commit/push” wording is
preserved with its superseding chronology; actual frozen prerequisite installation
and source publication are recorded. No application/WASM build was performed.
The 4,096 UTF-8 bound applies individually to type/message text fields, not the
entire typed record; prefix truncation still refuses.

## Lossless archive and offline replay

`manifest.json` lists every safe relative member, original size and SHA256.
`retained-hosted.tar.gz` uses zero gzip/tar timestamps and retains both full seven-
file artifact sets, job/run/ref receipts, original auditors/results, literal
dfd/0c2 runtime sources, and the corrected functional/source-gate receipts.
No IFC model, executable, dependency directory or secret is included.

```sh
python3 scripts/perf/evidence/post-timer-gpu-inputs-6537/replay-audit.py
```

Replay verifies archive/member hashes and safe regular-file paths before extraction
to an owned temporary directory. It executes each original auditor with exactly
one AST substitution: its Git source-byte lookup reads the corresponding captured
literal source instead. No predicate, expected bytes or result status changes.
Both regenerated qualification and artifact-hash outputs must be byte-identical
to the originals. Replay requires Python only and performs no GPU/model/build or
network work; temporary extraction is removed on exit. `replay.stdout` and
`verification.json` retain the actual roundtrip result.
