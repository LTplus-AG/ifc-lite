# Native SDK P0: executed PASS

Qualified source: `3af451ceeeadf226cb1c020e1c7248355215a630`.
Parent base: `9e2f76f661ce5854ec8cbbb457dcffb9669419fb`.
Pinned SDK: `c9c5979f04cea8c38213004d4f04df0dcfb40d05`.
Host: `pop-os`, GNU C/C++ 13.3.0, Release.

Full configure, all 254 build/link steps, and all four CTests executed and
passed. CTest elapsed time was 2.82 seconds; no CTest was skipped. This is a
native qualification result, separate from browser, product and performance
qualification. The exact kernel remains the default.

Final request: `auto-45c6490426dc4e239a0aa769db42c6e8`.
Final job: `048a471f-9c0e-4a80-a441-9a36002fd03b`.
The receipt records exit 0, clean source before/after and `sourceUnchanged`.
The executed command was:

```sh
/home/louistrue/build-workers/ifc-fleet run --host pop-os \
  --cwd /home/louistrue/.t3/worktrees/ifc-lite/t3-f974d7c7 -- \
  bash /home/louistrue/build-workers/setup/projects-20261017/ifc-lite/env-exec.sh \
  bash native/smlib-adapter/qualify.sh native .
```

The passing tests were `smlib_sweep_upload_transport`,
`retained_driver_protocol_lifetimes`, `smlib_worker_framing`, and
`smlib_owned_boundary`. The last test ran the real SDK: 21 completed region
witnesses, straight/curved rational disks, immutable rigid transforms,
malformed upload consumption, boolean/manifold and handle lifetime checks.
The detailed output is retained in `final/LastTest.log.gz`.

## Review responses

**Does the plane correction weaken the oracle?** No expected geometry counts
or numerical tolerances changed. For general extrusions, a plane containing
every Cartesian generator control point and parallel to the extrusion vector
contains the entire positive-weight rational surface. The certificate rejects
nonpositive/nonfinite weights, bounds the sweep-normal residual over the
finite STEP interval, and independently evaluates 25 surface samples at
`1e-8`. Other surface classes keep the original SDK classification. Volume,
bounds, cylinder identity, section lengths and analytic boundary checks remain.

**What did the old versus new query actually do?** On the retained oblique
region, two SDK extrusion surfaces returned `IsPlanar(1e-8) == false` while
both complete control hulls and evaluated samples had zero plane deviation.
The old classification therefore gives four planes/two curved surfaces; the
certificate restores the required six planes/zero curved surfaces. Both direct
UV arrangements also returned false from the SDK query, with zero control
deviation and sample deviation `2.2204460492503131e-16`. The direct curved
extrusion was rejected with control deviation `1.7888543819998317`; retained
curved regions were rejected too. A zero sample diagnostic on these early
rejections means the control-hull check stopped before sampling.

The pinned `SmSurface::IsPlanar` calls the default expanded pseudo-box query;
its Bezier box branch expands by radius/20. Runtime results establish the
current query mismatch. The historical source331 log identifies neither its
fixture nor observed counts, so its exact abort cause remains unconfirmed.

**Is SDK ownership correct?** The pinned extrusion constructor sets itself as
generator owner; its destructor deletes that generator. The regression releases
the curve's unique pointer after successful surface construction. SDK surfaces
also require context allocation for cache lifecycle notification: the initial
stack-allocated direct regression segfaulted after its first diagnostic. Using
`new(context)` under a unique pointer resolved it in subsequent actual runs.
`GetControlPolygon` explicitly converts homogeneous points to Cartesian and
returns empty weights for nonrational curves. STEP V remains the extrusion
interval when the natural UV arrangement is swapped.

**Why did native production code change?** Executed qualification exposed an
additional full-circle failure: `near-full-negative-over` returned SDK volume
`37.699067594865376`, expected `37.699111843077517`, outside the existing `1e-5`
bound. Constructing the full circle over a canonical SDK 0–360 degree interval
and moving its authored phase into the rigid frame removed the failure. The
final volume is approximately `37.6991113838`. The rotated basis represents the
same circle, seam and traversal; recipe bytes, center, radius, normal, sweep
sign and genuine partial-arc intervals are preserved. Tiny near-quadrant knot
spans are the source-grounded numerical explanation; no SDK was patched.

**Why did a disk test change?** Both disk volumes and transform geometry passed.
The old malformed test expected a 167-byte truncated shortest record to begin,
but the existing declaration gate rejects lengths below 168. It now asserts
that early rejection clears the token. A truncated longer curved record also
tests commit-time payload rejection, no published handle and consumed upload.
No production admission or geometric tolerance was relaxed.

**Were setup failures or old jobs replayed?** No. The prior r1 nonexecutable
wrapper failure is retained unchanged. A fresh two-bash request built and
revealed the direct-regression fault. A later request exposed CMake's cache
binding to the previous absolute checkout. Default build directories now
include source commit and physical checkout identity, retaining old evidence.
All existing mode/setup/physical-build locks and explicit override semantics
remain. Four diagnostic jobs reused unchanged prior SDK/adapter objects under
the original build lock in separate scratch outputs; they are explicitly not
the final full qualification. Every new submission has a distinct request.

## Evidence and delivery

`final/request.json` and `final/receipt.json` are byte-for-byte copies.
`final/output.log.gz` and `final/LastTest.log.gz` losslessly retain the full
qualification and per-test output. `prior-attempts.tar.gz` retains the original
r1 evidence, three failed full/setup runs and all four diagnostic runs.
`summary.json` records their request/job/source identities and raw SHA-256
hashes, the final source file hashes and retained archive hashes. Copies were
checked against the worker receipt's `outputSha256`.

The code-only incremental patch against the parent base is delivered at
`/tmp/ifclite-native-p0-f974d7c7-delivery/native-sdk-repair.patch`, SHA-256
`567313283c97a0eedf96d76673a09fab5e7a1d7c983c23d7036987bc28f1eebd`.
The final evidence-only commit does not alter the six qualified candidate
files. No Rust workspace job, SDK edit, push or PR was performed.
