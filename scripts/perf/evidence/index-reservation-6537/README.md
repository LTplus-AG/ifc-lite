<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Initial entity-index reservation (#6537)

This candidate lowers the initial speculative reservation in the canonical
hash-index decoder, columnar scan and serial WASM prepass. One shared core
helper requests the smaller of the existing source-byte estimate and 65,536
entries. Collections continue growing from every actual scanned record;
this cap limits neither accepted entity count nor final collection capacity.
A prebuilt prepass keeps its existing zero-reservation staging path.

This change preserves the scanner, spans, duplicate replacement and geometry
production. Source length includes comments and long attributes, so it cannot
establish the number of useful index entries before scanning. Hash-table
rounding, reallocation during real growth and the retained source buffer remain
costs. Lower initial reservation establishes neither physical peak RAM nor an
end-to-end speed improvement.

The real Rust regressions build a legal comment-heavy STEP input and a dense
input larger than the initial budget. They check bounded speculative table
capacity, ignored record-like text inside comments/strings, last duplicate
replacement, exact entity spans and complete dense-record recovery through
both canonical index forms. The cap is deliberately separate from the
refuted #1445 viewer shared-index experiment: it adds no shared-index build,
conversion buffer, worker routing or new load pipeline.

## Source and qualification attribution

The frozen candidate is `9c9132fd12301250a88dfc6d08eac8ebc19e4e2e`, based on
`bd0d02782b92581ed8e007effc9d00e37a09476e`. Its production WASM is SHA-256
`f2f35ff9284bfa8ff57aaa31d724462a44f50bb573cdedb3d7ada33ff1d8547a`.
The main integration preserves its four changed production modules and dense/
commented test file exactly. Current main `02eb22edd5b050b48ac8944e4a8a2a97316c6976`
adds unrelated viewer validation and other changes; all incoming source/evidence
blobs are preserved. No compiled artifacts are copied into this integration.
The committed WASM declaration surface and existing public JS contracts stay
unchanged. Release metadata targets the consuming WASM package as a patch.

The earlier `52ae57270d156cf91f790ec87f266dd9545e6aa7` candidate passed workspace
Rust tests and the existing WASM contracts. The frozen `9c9132fd` successor
only moves the shared helper before its test module and has its own strict
workspace Clippy and canonical full-build results. Those historical checks
must not be described as fresh current-main qualification.

The recorded small-model and legal-comment-density native-GPU cohorts belong
to their exact frozen source/runtime pairs. The density derivative is a
controlled valid public STEP input; it is not a second real authoring model or
a reproduction of the unknown private large-file failure. Ordinary heavy-file,
default worker-pool and fresh native-probe controls remain separate work.
An interrupted heavy cohort retains its qualified rows and contaminated row;
it does not establish a completed five-pair verdict. No speedup, all-model,
physical-memory or private-file success claim is made.

## Pending current-main checks

The integration is prepared for source review. Its own dependency graph,
current WASM contracts, exact plain root typecheck, official production revert
oracle and documentation/license gates have not run yet. They must report
actual terminal outcomes and source/runtime identities before publication.
The test plan is kept alongside the source-review handoff; no performance run
is authorized by that plan. Numeric evidence and final measured disposition
will be archived with their raw samples after independent review.
