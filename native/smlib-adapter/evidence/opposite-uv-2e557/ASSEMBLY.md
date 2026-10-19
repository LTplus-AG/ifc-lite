<!-- SPDX-License-Identifier: MPL-2.0 -->
# Opposite-use correction assembly

Apply only after unchanged2e557ea7116d3e8299dc11e8fab8eb5198c47541. Preserve all
old checkpoints and evidence. This is one narrow source/test/contract repair,
not a source overlay. summary.json records exact three before/after SHA256 pairs
and unchanged safeguards; evidence files do not self-hash.

Only face_extraction.cpp, face_extraction_tests.cpp and
CHECKED_NUMERICAL_READ.md change outside this new evidence directory. All
ledger/fixed-read/representation/generated-constructor production, copy/context,
plane/protocol/public header/CMake/qualify and Rust/JS/runtime remain unchanged.
Native production modules remain <=400 lines. No SDK source edits.

C++17 syntax-only parsing with -Wall -Wextra and git diff --check pass. No child
SDK execution, configure/build/link/test, WASM, Rust, performance or heavy job.
The corrected attachment witness and integral stages remain UNRUN. Parent owns
review, integration and actual admitted validation. No volume8/area24, later
split/merge success, full paired-interface proof or op21/cap128 claim.
