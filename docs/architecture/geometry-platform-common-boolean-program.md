<!-- SPDX-License-Identifier: MPL-2.0 -->
# Common boolean/CSG program

This layer extends the representation/constructor program with the canonical
boolean and CSG continuation. The exact Rust kernel remains the default and
permanent implementation. Public synchronous callbacks and scoped worker
borrows keep their signatures. No alternate loader or engine is introduced.

`geometry/src/program/boolean` owns the continuation, FirstOperand spine,
conditional step admission, grouped attempts and operand dispatch. The replaced
processor continuation and combined source/numeric step files are deleted.
`BooleanProgram` owns frames, quality, path membership and monotonic visits.
It retains no decoder, recorder borrow, router or runtime guard. Synchronous
entry adapters temporarily move the caller's OperandPath into the child and
return it through an owned restoration guard on success, error or unwind.
Normal Result cleanup removes only this child's active memberships; enclosing
ancestors and spent visits survive. Unwind retains the entered memberships too,
matching the original borrowed path rather than resetting the caller's state.

Ephemeral Services supply the actual recorder and mutable decoder at reached
transitions. CSG root validation and its depth reset retain their earlier order.
The polygonal collector still speculatively reads direct references before the
base, including an empty base. Cutter descendants are lowered only after the
base returns nonempty. Empty Difference/Intersection and unknown operators leave
unused operand descendants unread. Empty Union records before RHS admission.

`work.rs` supplies owned, typed numerical payloads for constructor evaluation,
plane clipping/capping and recovery, host-dependent prism construction, the
single-cutter policy, solid booleans, grouped cutters and void shells. Payloads
contain explicit planes, host/cutter meshes, unit scales, quality and policies;
they cannot call a decoder or router. A mesh moves into the numerical operation
and back in its typed result, including prism failure recovery. There is no
borrowed source callback hidden inside an execution payload.

Each numerical operation collects only its own boolean failure effects in a
schema-free `NumericalEffects` log, then returns a consuming `Completed<Operation>` to the synchronous
assembler. Effects are appended to the actual configured processor even when
its numerical result is an error. A lexical numerical-only guard forwards
already-produced records to the original sink on unwind; normal completion
drains them into the owned receipt before the guard drops. It retains no source
service, changes no caller scope and does not catch the panic. No process-global census or caller diagnostic
scope is drained or replaced. A deferred group rewinds the original provisional
boolean mark before publishing its unique union failure, if any. Source reports
and operand visits remain outside that rollback domain. Preparation deferral
re-enters the original FirstOperand continuation. Exact kernel and triangulation
call order remain the original algorithms, reused from the processor plan modules.

Leaf admission calls `lower_owned` on a fresh historical builtin, independently
of router custom registrations. The enclosing product dispatcher continues to
use its actual selected root hook or borrowed callback. Outer-only host BRep
semantics remain distinct from cutter Voids: shells are admitted and evaluated
one at a time; the next shell and unit lookup wait for nonempty prior results.
Plane kept-side and prism success gates likewise precede contour/unit admission.

These are private synchronous, consuming seams. They do not define detachable
worker tickets, cross-session reply authentication, resource accounts or a full
resource envelope. Common source coherence and checked resource admission have
separate owners. Opening orchestration, layer slicing and presentation admission
remain outside this incremental layer. No end-to-end performance improvement,
complete platform replacement or new guard limit is claimed. Qualification
receipts identify the exact source checkpoint independently of inherited evidence.

The numerical log contains only a `RefCell<Vec<BoolFailure>>`. Its empty default
requires no backing allocation and never constructs `IfcSchema`; constructor,
prism and shell work therefore no longer create an unused full Boolean processor.
The existing numerical algorithms use this same log type, and source admissions
publish to the selected processor's log. This removes the identified per-work
schema allocation mechanism; it is not an end-to-end allocation or latency
verdict. No whole-worker-pool measurement qualifies this correction yet.
