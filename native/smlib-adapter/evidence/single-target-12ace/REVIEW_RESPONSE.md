<!-- SPDX-License-Identifier: MPL-2.0 -->
# R1 target authority retention repair

Base remains frozen12ace76be215f697814aaf579a741c2f34273cbe, unchanged.
The review is correct: conditional same-body validation followed by unconditional
predecessor reset allowed switching to B to forget A's terminal representation.
An edited A could then be recaptured as a fresh pre-state.

The private contract now supports exactly one completed transition target per
ledger. A different target is refused before the old seal is discarded or SDK
mutation starts. The old completed plan remains retained through successor
preflight and execution, even when that preflight refuses. It is replaced only
after a successful operation on the same target. There is no per-address
registry, forgotten-target re-adoption or multi-target authority claim.

Lifetime continuity additionally requires the actual observed BRep constructor
generation. Pinned SmBrep.cpp:576/682 notifies construction;707 notifies death
before topology teardown. Incomplete lifetime records now track these events,
without authored/source roots or persistent IDs. Preflight and receipt consumption
require the exact live constructor generation. Even a replacement BRep at the
same address is refused before retained graph inspection or SDK operation.
The previous merged face generation and full terminal representation also remain
required. Current face indices, a seal of a new lifetime or caller integers
cannot recreate the original target's authority.

Actual SDK witnesses (all UNRUN):

- `transition_target_switch_refusal`: A completes/consumes, B is refused without
  SDK events/nodes or changes to B, untouched A repeats, an invalid same-A
  successor refuses, and an actual public A head rotation (statusSUCCESS,
  counter1) causes retained-terminal-seal refusal rather than new adoption.
- `transition_target_reuse_refusal`: actual A BRep destructor must report the
  original constructor identity; within128 real BRep allocations actual address
  reuse must occur, with a different constructor generation. The replacement
  must hit lifetime refusal before any operation/event/node change. No alias
  skip or simulated pointer reuse is accepted.
- Existing `split_merge` untouched-A repeated transitions, all receipt/frame/head
  negatives, signed volume8/area24, source/copy lifetime and the original8 process
  boundaries remain. No old witness is removed or relaxed.

The predecessor terminal seal remains live during successor construction. Its
memory does not increase the existing four-seal bound: after typed discharge,
the successor releases its pre-seal before its final fixed numerical read.
Post-start uncertainty still taints the whole isolation status8. No ordinary
numerical/head mutation waiver, new root, opcode21 or paired closure claim.
