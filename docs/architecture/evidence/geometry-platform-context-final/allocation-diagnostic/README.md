<!-- SPDX-License-Identifier: MPL-2.0 -->
# Requested-allocation diagnostic

This is a standalone consumer of the pinned existing base and candidate profiling
libraries. It invokes the real `process_geometry` with the default worker pool;
no production implementation or numerical path is replaced. Both executables
use the same consumer source, allocator wrapper and compiler flags. This is a
diagnostic of allocation traffic and requested live bytes, not a latency test or
an allocation-site profile.

The `GlobalAlloc` wrapper delegates to `System`. It records successful allocation
and zeroed-allocation requests, frees, reallocations and their old/new requested
sizes using atomics. A real Vec allocation/reallocation/drop self-check runs
before measurement. Input reading and explicit global Rayon pool creation and
broadcast occur before the first baseline. Each fresh process loads the same
model five times. Each model runs in base/candidate/candidate/base order.

Cumulative counters and live requested bytes are never reset: the source buffer,
worker pool and other preexisting allocations remain counted. Only peak live
bytes are reanchored to the current live gauge at each call boundary. Each record
contains before, immediately-after-processing and after-result-drop snapshots.
`process_delta` contains differences for cumulative counters; its `live` and
`peak` fields remain absolute gauges. Derived differences are provided separately
in the summary. Geometry fingerprints use the unchanged performance-probe helper,
after the processing snapshot; they omit metadata, UVs, textures and instances.
Fingerprint temporary storage is gone before the result-drop snapshot.

The measured bytes are requested backing storage visible to Rust's global
allocator. They exclude allocator metadata/arenas/rounding, fragmentation,
external native allocation, thread stacks, mmap and GPU/browser memory. A
reallocation's internal transient old/new storage coexistence is invisible.
Atomic observations under concurrent worker activity are diagnostic samples, not
a proof of a hard live-memory bound. The deallocation gauge updates after the
System call, so overlapping allocation/deallocation callbacks can affect a
transient observed peak. Request traffic is not a count of bytes actually copied.

GNU time maximum RSS is retained separately for the entire process, including
five loads, input, worker initialization and fingerprinting. It cannot be
substituted for requested live bytes. Other host work ran concurrently and the
instrumentation itself adds atomic contention. No timing verdict or causal
allocation-site attribution follows from this run. First-load worker TLS and
persistent processing caches are included in the processing interval; raw
iterations retain that distinction.

Small sources, exact driver, raw JSON snapshots, logs, RSS samples, compiler,
fixture hashes, library hashes and commands are persisted here. Executables and
linked libraries remain local temporary/build artifacts; their hashes identify
them but do not make those binaries available from a clean checkout. The parent
source manifest and overlay receipts identify the separately qualified candidate.
