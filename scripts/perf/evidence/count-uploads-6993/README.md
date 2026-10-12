<!-- This Source Code Form is subject to the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Production GPU count cohorts (#6993)

`production-counts.json` records two fresh-document loads each of the public
FZK and Snowdon fixtures, using the production viewer and the T3 collaborative
browser on the Windows NVIDIA Blackwell adapter. The adapter is not a
fallback. Geometry workers and job sizing are fixed; mesh caching is disabled.
Each accepted run has a completed scene finalization and stable structural
counters. No recorded device loss or replacement occurred. The shared
`/tmp/ifclite-perf.lock` was held for the bounded GPU cohort and released.

Both fixtures repeat GPU buffer count/allocation bytes, static-upload
count/bytes and sender transfer bytes exactly. Queue-drain frame boundaries
and finalization chunks differ, demonstrating that those boundaries no longer
define fragment grouping. The GPU fields count actual native allocations and
successful submissions from the shared static-upload helper.

Aggregate `gpu.writeBytes` includes mutable table updates and varies between
these runs. It remains scheduling-dependent. Static geometry and instance
uploads have separate `gpu.staticUpload` counters; uniforms also remain
scheduling-dependent. The initial aggregate-write variance was retained and
led to this separation, rather than widening an exact-count tolerance.

`source-binding.json` pins the six renderer/viewer runtime owners and the
production index. The unchanged WASM runtime comes from the exact-base green
main run recorded in the lower worker-accounting evidence. Fixture digests
match the repository manifest. No CPU mesh byte-identity claim is inferred
from these counters, and no latency or throughput verdict is claimed. The
count workload is refused by timing comparison/baseline consumers.

The first Snowdon capture exceeded the preview tool's evaluation deadline;
the load continued normally and its finalized state was captured separately.
The initial smaller-slice FZK exploration is diagnostic evidence only. The
accepted pairs use the same final production build and policy.

The final CI correction restores the standard MPL notice in `scene-flush.ts`
(and four other new files). The receipt hashes intentionally retain the
original qualification inputs; this comment-only producer edit does not
change upload behavior. A later cold A/B consumer guard also rejects a count
mode observed in the trace, even when the harness requested timed uploads.
These post-qualification edits do not represent another native GPU cohort.
