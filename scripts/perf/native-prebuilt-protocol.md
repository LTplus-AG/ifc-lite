# Native held-FD protocol proposal — #6537

Current state: bounded functional ELF qualification is complete. The old 48
controls passed. The new control first exposed two genuinely empty imported
Python 3.14 module files; their hashes are retained with an explicit closure-only
empty-file opt-in, while binary/receipt/fixture reads remain nonempty by default.
The final FD control passes. Both unchanged-oracle surgical inverses fail through
real assertions, and byte-exact restoration passes. The combined intermediate
49-pass source predates that stricter opt-in and is retained separately.
The single dedicated startup also passes at the unchanged 250ms cadence: its
ELF-reported inode/PID/argv agree with the held-file intent and initial owner,
with no compiler exceptions, complete cleanup/drains and final file verification.
This proves the independent ELF/control seam, not the full canonical IFC command.
Subject builds and hosted samples remain **UNRUN**.
This is a measurement-controller change, not a model-loading optimization or
an accepted performance result.

The previous controller's exact Cargo target-information query was witnessed in
state R and became Z before its live executable could be pinned. Run 37175610695
therefore correctly refused before subject builds, with zero pairs. Its receipts
and earlier compiler-query controls remain unchanged.

The proposed controller builds the literal declared arms with the existing fresh
`--locked` Cargo command. It separately invokes each **unmodified original arm**
`scripts/perf/probe.sh` against Haus outside the paired cohort. That original
command has no `--locked` flag. Only the controller/arm `probe.sh` byte-equality
requirement is replaced by an explicit compatibility record; Rust phase/output
measurement sources and toolchain equality are still required.

The timed cohort uses the controller's explicit `--verified-prebuilt` mode.
It does not source Cargo shell initialization or run Cargo. A single private
Python validator checks literal clean source heads, actual runtime hashes,
consumed modules/policy and observed libraries, fixture hashes, environment and
the canonical profiling ELF's inode, size and hash. It opens that regular ELF
with `O_NOFOLLOW`, hashes the held FD, rechecks its binding, and invokes numeric-FD
`os.execve`. There is no pathname-exec fallback. `-I -S -B` isolates Python imports
and disables bytecode writes. Hashes are recorded for the interpreter, consumed
stdlib/extension files, policy and observed linked libraries.

The pre-exec witness records **intent**, bound to the controller-observed initial
PID/start/group and source cwd. It is not proof that execution succeeded. Accepted
samples also need actual successful exit, strict canonical result JSON, five
iterations, mesh/count FNV identity, complete raw logs, cleanup, frozen-file checks,
and the independently reporting ELF controls. Optional native `/proc` observations
are recorded if seen; a short program can finish before the fixed 250ms poll.

The existing schedule, 10% CPU and A/A thresholds, resource floors, raw-log bounds
and owned-process cleanup are unchanged. The FD timed path rejects **all** observed
compiler/test graphs, without Cargo/query exceptions. The old read-only compiler
controls remain regression controls; only the legacy startup-only route requires
the fleeting Cargo-child startup. The new native route requires the real FD startup.

The finite controls compile a tiny independent ELF that reports its own kernel
`/proc/self/exe` inode, PID and argv. They compare those observations with the held
object, then replace the pathname and require the original held object to run.
They reject wrong file/fixture/source/environment/closure bindings, symlinks,
non-ELF files, altered arguments and reused owner metadata. The numeric-FD-to-path
inverse actually ran the replacement ELF and failed its marker/inode assertion.
The digest-only bypass actually accepted wrong SHA metadata and failed the
invalid-receipt assertion. Tests were unchanged; both mutations were restored
exactly before the same control passed again.

Limits: no IFC, browser, worker-pool, full appearance or speed proof comes from
these controls. Native FNV excludes appearance channels documented by the original
protocol. Holding an FD prevents pathname substitution, not concurrent writes to
the same inode; trusted owned artifacts, before/after verification and recorded
environment/library closure provide a bounded provenance contract, not adversarial
whole-machine immutability. Cargo registry/build-script/linker closure and loader
inputs beyond observed libraries remain explicitly incomplete.
