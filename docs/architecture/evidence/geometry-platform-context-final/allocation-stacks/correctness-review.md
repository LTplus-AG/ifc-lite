# Sampler correctness review and remaining qualification

This is a bounded standalone diagnostic design, not a production source change.
The completed exploratory runs are preserved separately from corrected source.
No final caller attribution is made because symbolization and a corrected rerun
have not received worker admission.

The gate/drain correction uses sequentially consistent operations for ENABLED
and ACTIVE. In the global atomic order, a writer registers ACTIVE before its
second ENABLED check. A writer observing enabled on that second check must have
registered before the closing disabled store; the closing thread therefore
cannot pass the ACTIVE-zero drain until that writer publishes its completed
slot and decrements ACTIVE. A writer registering after the closing store must
observe disabled on its second check and cannot write a slot. Thus a late
registration does not allow a late slot write after the reader starts. Release
publication on decrement and acquire observation in the drain also order slot
contents. These guarantees are represented directly by the corrected SeqCst
operations; they are not claimed for the exploratory generic gate protocol.

Each sampled writer owns a unique fetch-add index into 32768 fixed slots.
Readers only access the initialized prefix after closing and draining. A slot
beyond capacity increments dropped and never writes outside the array. The
stack buffer has 96 pointer-width entries and is passed directly to glibc
backtrace; the program is a Linux native consumer. A full buffer is reported as
truncated, never represented as a complete call chain. No heap allocation is
performed by trace-slot bookkeeping. Dynamic loader/native backtrace internal
memory is outside Rust GlobalAlloc accounting.

Backtrace is warmed on the main thread and every Rayon worker before enabling.
A constant thread-local recursion guard excludes recursively instrumented
requests; exclusion is counted. A real 65537-byte Vec probe must produce exactly
one sampled request of that size and a nonempty stack before the real measurement.
Its recorded addresses are retained for later symbol-name validation. The probe
is not counted as production work. A nonempty trace alone does not prove correct
caller symbols, so known-probe symbol resolution remains a mandatory next step.

Sampling covers successful alloc, alloc_zeroed and realloc requests only during
process_geometry. Free operations and source read/pool setup/output fingerprint
and JSON serialization are outside sampling. Reallocation records old and new
requested sizes; the new size is not a measurement of actual bytes copied.
Samples are every2048th successful request in the shared event order, not random
independent draws. Repeating order across tight loops can bias both sites and
sizes; no exact site counts or total-byte extrapolation is justified.

All four exploratory runs have zero dropped slots, zero full-stack truncations
and zero recursively excluded requests. Sample count equals ceiling(total
successful events/2048) in every process. They provide 14587 base and15570
candidate samples per process, over two real loads each. Geometry signatures
match all eight loads. None of that establishes site attribution before the
actual executable addresses are symbolized and audited.

The prepared symbolizer will require ELF EXEC, normalize return PCs by minus1,
resolve executable text addresses with addr2line including inlined frames, and
require the known probe function to resolve. It retains unresolved external
frames as unknown. Innermost project-frame and inclusive project-frame summaries
are separate; inclusive totals overlap and cannot be added. Per-run samples,
request-size sums and actual representative stacks must be retained. The same
source is rebuilt against both pinned library sets; source/layout differences
are not normalized into invented shared site identity.

The corrected rebuild/rerun was submitted once through the mandatory fleet
launcher. Local admission refused before command execution because available
disk did not satisfy the configured reserve plus scratch requirement. The
refusal receipt is retained. No guard bypass, remote dirty-source transfer,
unadmitted symbolization or automatic retry was attempted. Existing exploratory
runs began before the policy transition and are not relabeled admitted.
