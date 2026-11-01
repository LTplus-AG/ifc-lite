<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# ROUTER-21 (+ ROUTER-20) spike, #8385: closed with numbers

Base `ea0139026b` (main). Fixture ISSUE_129 (`sha256 ffdfa9a9…02642131`).
Bar: geometry Ir on ISSUE_129 at least 0.5 % lower, which is 138.7 M Ir.

## Sources

- `opportunity.sh`: `instructions.sh` phases, then one more single-threaded
  callgrind run of the same phase-marker `perf_probe` with no phase dumps, for
  inclusive Ir and call counts. Fleet job `e7527fe6-fd0e-4f6d-ad07-d76a6fd4e268`
  (request `auto-68d353bcec08420ba56e83ed69c66882`), Pop, commit `40fb84a375`
  (the base plus this script only), exit 0.
- `count.patch`: throwaway `eprintln!` counters on every opening child run
  (classifier, residual pass and rectangle capture) and every
  `extend_opening_mesh_through_host` call in the coaxial union. It applies to
  the base and was built in an exported copy, never committed as code. It ran
  as a local admitted run (`run-heavy`) on Pop, release `perf_probe
  --single-thread --iters 1`. Its 1,351 child runs and 50 + 49 + 18 extension
  calls match the callgrind call counts exactly.

## Base phases, ISSUE_129

| phase | Ir |
|---|---:|
| parse | 257,333,844 |
| entity scan | 251,704,886 |
| lookup | 21,453 |
| preprocess | 5,477,054 |
| geometry | 27,747,592,768 |
| total | 28,004,959,060 |

## ROUTER-21: how often each opening is meshed

361 `IfcRelVoidsElement`, 361 distinct (host, opening) pairs reach the
classifier. 1,351 opening child runs in all, 3.74 per opening on average:

| run | count |
|---|---:|
| body (product walk), recording pass | 361 |
| bounds probe, recording pass | 361 |
| item-mesh probe, recording pass | 352 |
| per-part fallback bounds probe (#635) | 9 |
| body, quiet planar residual pass | 71 |
| bounds probe, residual pass | 71 |
| item-mesh probe, residual pass | 71 |
| rectangle capture item meshes | 55 |

Per opening: 235 meshed 3 times, 55 four times, 71 six times (the residual
pass re-classifies them).

Cost (callgrind inclusive, all 1,351 calls of `OpeningChild::run`):
62,556,287 Ir, 0.225 % of geometry. The 432 body walks are 58,226,721 of it
(about 134.8 k each); the 919 item probes together are 4,329,566 (about 4.7 k
each).

Meshing each opening once would save an estimated 13.9 M Ir (0.050 % of
geometry): the 71 repeated body walks at the 134.8 k average (about 9.6 M;
not measured per walk) plus every item probe (4.3 M, measured). The hard
ceiling is deleting all opening capture work (child runs 62.6 M, numerical
packets 18.8 M, source requests 15.8 M, poll/resume 10.2 M, about 107 M
together, all measured): 0.39 %, still under the bar.

## ROUTER-20: through-host extension recomputed

`extend_opening_mesh_through_host`: 170 calls, 236,680,610 Ir (0.853 % of
geometry). Admission in the coaxial union 50 calls (84.8 M), coaxial prism
build 49 (137.8 M), `sequential_cutter` 53 (11.9 M), 3D union 18 (2.3 M).

A memo is byte-safe only for a call with the same host (no cluster has cut it
since admission) and a bit-equal direction. Of the 67 repeat calls:

| site | same host and direction | host already cut | other direction |
|---|---:|---:|---:|
| coaxial prisms | 27 | 20 | 2 |
| 3D union | 18 | 0 | 0 |

The hits sit on small hosts (24 to 2,628 triangles, 18 of them at 84); the
misses are the large hosts (317 to 7,104 triangles) after an earlier cluster
cut them. Cost scales with host size at about 2.0 k Ir per host triangle (1,944
at admission, 1,993 in the prism build), so the reusable calls cost an estimated
18.7 M + 2.3 M = 21 M Ir, 0.075 % of geometry (extrapolated from that rate,
not measured per call).

## Verdict

ROUTER-21 and ROUTER-20 together would remove an estimated 35 M Ir, 0.13 % of
ISSUE_129 geometry, against a 0.5 % bar. ROUTER-21 alone has a measured
ceiling of 0.39 %. No code change was made. Do not
re-spike either without a mechanism that removes the extension or body walk
itself rather than its repeats.
