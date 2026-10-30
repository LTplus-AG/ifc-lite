# C4-11b structural layer (#7782)

Stacked on C4-11a #8320 (updated base `6246d22dc4`, including #8317/#8318).
`ContentState` owns source bytes,
pending finalize finishes, derived slots and the existing ProductionModel.
Slot declarations generate the reset walk, including BRep signatures. The
one-lock `LazySlot::get_or_init` covers discovery and publication; explicit
installs retain poison recovery. Session settings and readable end-of-load
diagnostics remain on IfcAPI. `setSourceBytes` retains exactly C4-11a semantics.

PrepassMode couples sharded columns to external style ownership. Fingerprinting
is an independent PrepassOptions choice; all public positional signatures stay
unchanged. The second layer removes metadata snapshots and splits emission.

The concurrency witness uses the real type/mapped discovery on the in-tree IFC
fixture. Its reverse-applied mutation disables slot retention and must fail the
shared-plan ownership assertion. The C4-11a reset witnesses remain wired.
The selector is the first elif after acceptance-harness-8112; its extracted
shell passes `bash -n`. The patch passes `git apply --reverse --check`.

`api/mod.rs` shrinks from 949 to 492 lines. Its budget and digest are lowered;
this layer keeps the 501-line prepass function budget until the completing split.
The C4-11a reset witnesses and concurrency witness passed in the completing
layer's pre-integration full workspace/clippy run at `3d5c31764b` on Pop
(`auto-9b0616c072274805b13a79b8547f58a6`); the reverse mutation was caught.
Post-integration results and exact fleet commands live in
`tests/evidence/c4-11b-prepass/README.md` on #8329. No timing speedup is claimed.

The initial slots task's field-owner compile error was fixed at `35eb14e3c7`.
Its evidence was published, the task closed, and its unused generated checkout
reclaimed through registered storage: 942,592,000 bytes. Shared caches and foreign
work were preserved.
