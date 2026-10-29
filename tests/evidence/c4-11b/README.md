# C4-11b structural layer (#7782)

Stacked on C4-11a #8320 (`06cf742446`). `ContentState` owns source bytes,
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

No end-to-end speedup claim. Fleet results and the allocation measurement are
recorded with the completing prepass layer; pending coverage is not a pass.
