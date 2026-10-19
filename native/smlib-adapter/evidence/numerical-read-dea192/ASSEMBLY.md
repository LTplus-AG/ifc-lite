<!-- SPDX-License-Identifier: MPL-2.0 -->
# Numerical read repair assembly

Apply this increment only after frozen dea192484d99dc9d6713d25f478c7bddd2eaf871.
Preserve all previous frozen commits/evidence. No broad native overlay.
summary.json lists exact before/after SHA256 for each source/test/contract path
and unchanged local safeguards; evidence files do not self-hash.

Two source-backed production repairs and their witnesses are described separately
in CHECKED_NUMERICAL_READ.md: exact source UV transfer in extraction; private
fixed numerical calls with generational detached-copy receipts and full retained
source equality. Both belong to the parent's actual6/7 read-phase failures.
The previous constructor and destructive-fault fixes remain untouched. Parent
source4a85 qualified those reached stages, not this changed source.

No copy.cpp/context_metadata/plane/protocol/public header/Rust/JS/qualify/CMake
changes. Preserve parent current production and harness work, including all8
CTest process boundaries, original tolerances and defaults. Native modules stay
<=400 lines. SDK c9c5979 remains clean. Only metadata and C++17 syntax parsing
with -Wall -Wextra are performed here; no SDK execution/link/configure/build,
CTest, WASM, Rust, perf or child heavy job. New actual witnesses are UNRUN.

Freeze for parent pinned review/admission; no further partition expansion.
Failure of a new incidence/equality/read-class check is a concrete hold to
investigate, never a reason to widen the phase or discard a witness. Full
paired shared-intersection/partition/interface proof remains unfinished.
