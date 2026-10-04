<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->
# Exact owned Cargo compiler-query evidence (#6537)

This qualifies the local dependency-free startup guard for the two exact frozen
Cargo compiler queries: version and target information. It does not qualify IFC
processing, a hosted subject run, elapsed comparisons or a performance benefit.
The current eight source hashes are in [index.json](index.json). The earlier
[version-query packet](../native-version-query-6537/README.md) remains unchanged.

Normal native execution keeps its fixed 250 ms observer. Only the named startup
control uses 2 ms; neither cadence guarantees that a short child is observed.
The target query must pass all 21 fresh ancestry, exact argument, live binding,
held regular executable FD size/inode/hash and final process-disposition checks.
Missing or contradictory observations still refuse. No compiler wrapper,
process pause, polling override or general compiler exemption was introduced.

The retained chronology keeps failures separate from qualification:

- Published controller `299df39f7d834fcbd763a6bfb3e323f7e50ec374` hosted run
  **37171621347** refused the target query before either subject build; zero
  pairs completed. The earlier version-only qualification did not cover it.
- The first exact-query suite had 41 passes and one genuine assertion failure:
  its negative fixture changed a cached parent-group field instead of the cached
  PID/start identity. Correcting that fixture preserved the live group checks.
- The corrected suite passed 42 controls. Exact-query widening produced a real
  assertion failure. The initial hash mutation had a module-load syntax failure
  and is **inconclusive**; its separately corrected mutation produced two real
  assertion failures. Byte-exact restoration passed the unchanged controls.
- Real print-query controls used a valid header and poisoned body. The exact
  target query succeeded without changing owned sandbox files; ordinary
  compilation reported the body errors. This does not certify no filesystem
  reads or transient writes; no syscall trace was run.
- Whole-cache and selective-cache startup attempts admitted a version query but
  did not witness the mandatory target query. They remain **REFUSED**. The
  selective-cache suite passed all 48 controls with no failures or skips.
- Same-probe V3 warm-up completed, but its sample refused an actual foreign
  `pnpm lint` graph. Its final selected-cache bytes and complete cleanup are
  retained; no retry was made in that attempt.
- After a separately authorized fresh strict resource/CPU/process admission,
  same-probe V4 observed the real target query with all 21 predicates positive.
  Both executable pins were hashed; the child exited after its pinned positive
  observation, while the parent stayed live. Cargo admission, both pipe drains,
  owned process cleanup, holder exit, frozen-tool verification and removal of
  the temporary crate completed. No further startup followed this attempt.

Warm-up and sample use the same canonical Bash/probe/Rustup command, purpose,
arguments and explicit compiler selection. Only the startup observer differs.
Selective surgery preserves every byte outside the uniquely observed target
cache member and separator, including the opaque u64 fingerprint and cached
version output. V4's final cache restored the exact original bytes. The earlier
direct-Cargo attempt did not retain its final cache, so the historical
fingerprint-reset explanation remains supported by the mechanism, not proved
retroactively. Environment receipts record parent presence and explicit
selection, not the unobserved Rustup child environment.

The deterministic archive retains original JSON, logs, stdout/stderr and text
receipts only. Source/tool identities are metadata; excluded copied code files
are listed in the index. No models, executable binaries or dependency trees are
included. All member bytes were compared directly with their original receipts.
The bounded reader is byte-identical to the previously reviewed reader; it
checks stored/member hashes, safe file-only paths and compressed/TAR/member
bounds. It does not execute archived code or replay the compiler.

```sh
python3 scripts/perf/evidence/native-cargo-query-6537/safe-extract.py /tmp/native-cargo-query-review
```

Hosted native qualification of this correction remains unrun. Standard installed
CI gates and substantive review remain required before readiness or merge.
