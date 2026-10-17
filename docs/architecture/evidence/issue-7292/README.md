# Filled finite-surface comparison

`compare_surface.py` compares recorded meshes in metres against pinned
IfcOpenShell geometry. Its `finite-coverage-v3` contract is unoriented filled
surface coverage at the existing binary64 `0.0001` metre tolerance. It does not
establish closure, winding, multiplicity, volume, or production CSG correctness.

Install `tools/ifcopenshell_reference/requirements.lock`, then run the executable
controls from the repository root:

```sh
python -B -m unittest tools.ifcopenshell_reference.test_surface_coverage -v
```

The reporter CLI accepts `--fixture`, `--candidate`, `--slope`, and `--output`.
Corpus mode accepts `--mode corpus --fixture MODEL --base BASE_CAPTURE
--candidate CANDIDATE_CAPTURE --oracle-cache VERIFIED_CACHE --output OUTPUT`.
Each capture supplies `receipt.json` and `produced-mesh.json`; corpus comparison
also verifies the existing fixture, unit, placement and RTC contracts. The cache
must carry the pinned engine versions and source hashes. No IFC parse occurs
when a verified oracle cache is supplied.

The CLI's `passed` field and exit status require full conformance and the frame
checks, including in corpus mode: exit 0 means full PASS, exit 1 means failure,
and exit 2 means unresolved coverage, including work-bound exhaustion or a
positive-area triangle with an unrepresentable diagnostic projection. Localized baseline comparison is a
separate `summary.localized_delta_passed` field. An unchanged preexisting error
can pass the localized comparison while full conformance and the CLI still fail.

Plane bins organize diagnostics. Corpus discovery and assignment share an
exact nonzero-area check on the rounded projected donor corners. A nearby
perpendicular carrier cannot absorb a positive triangle as a line; discovery
adds its own carrier when necessary. Fixed analytic reporter planes are never
expanded, and a donor without a faithful chart remains unresolved. This #7721
change does not alter the finite distance certificates or their limits.

A donor triangle can receive coverage from a
finite target in any bin. Rounded projected corners define an affine parameter
triangle whose exact rational inverse maps onto the actual donor. Convex
discovery regions partition that triangle with exact rational clipping. A piece
is removed only when all its vertices are within tolerance of **one** actual
finite target triangle. Convexity proves coverage of its whole filled interior;
different targets cannot independently credit its corners. Discovery buffers
and floating polygon unions never establish acceptance.

Full comparison checks both directions. Localized comparison conservatively
exempts missing oracle pieces only when their entire surface is farther than
tolerance from every baseline piece not proved present at exactly the same
candidate positions. Excess candidate pieces are exempt only through exact
zero-distance baseline coverage. Neither rule spends a second tolerance.
Exact finite triangle intersection precedes the vertex/edge distance minimum.

Uncertified pieces fail conservatively. Their diagnostic areas and WKTs can
include covered points and must not be described as proved geometric errors.
The original exclusive-bin calculations remain under
`exclusive_plane_bin_diagnostics`; they do not control acceptance. A single
comparison shares a deterministic work budget, with rational-size and live-cell
bounds. Exhaustion reports unresolved and never passes. Receipts version the
comparator and hash both Python sources. Keep previous receipts unchanged and
write new outputs when re-adjudicating a corpus.

The no-IFC controls reproduce #7661's perpendicular-edge defect and exercise
finite extents, interior holes, tiny positive-area facets, exact tolerance
boundaries, input ordering, target subdivision, and baseline localization.
The comparator was introduced as evidence tooling for #7292; promoting it here
allows its independent correction and CI verification before the kernel PR.

Fresh uncached reporter references also retain `oracle-diagnostics/` from an
owned IfcOpenShell worker. Terminal Boolean fallback refuses the reference
before finite adjudication, with exit 2 and an `INVALID_OR_UNRESOLVED` receipt;
use a fresh output directory. See the shared [reference validation contract](https://github.com/LTplus-AG/ifc-lite/blob/main/tools/ifcopenshell_reference/README.md#rejecting-invalid-boolean-references-7723).

Fresh references record `ENGINE_DIAGNOSTICS_CHECKED_NOT_BOOLEAN_PROOF` and
the completed sidecar hash. Cached historical arrays remain explicitly
`UNVERIFIED_LEGACY_CACHE`; their finite comparison outcome is unchanged.
An explicit invalid-reference marker is refused even if mesh hashes match.

## Historical #7292 capture archive

The newly submitted historical JSON captures and their immutable receipts are
stored in `historical-captures.tar.gz`. This changes their packaging only:
every extracted file retains its original repository-relative name and exact
bytes. `historical-captures.manifest.json` records each decoded byte length and
SHA-256, plus the archive checksum. The archive has sorted USTAR members with
zero timestamps and owner IDs, mode 0644, and an empty gzip filename.
The source/input manifests, comparator sources and active fixtures remain in
place. Historical receipt statuses and reference limitations remain as recorded.

The comparator reads ordinary JSON; it does not read gzip files directly. Expand
into a fresh scratch directory before using the existing reporter/corpus CLI:

```sh
capture_scratch=$(mktemp -d)
capture_manifest=docs/architecture/evidence/issue-7292/historical-captures.manifest.json
python3 - "$capture_scratch" "$capture_manifest" <<'PYVERIFY'
import hashlib, json, pathlib, sys, tarfile
root = pathlib.Path('docs/architecture/evidence/issue-7292')
manifest = json.loads(pathlib.Path(sys.argv[2]).read_text())
archive = pathlib.Path(manifest['archive']['path'])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest['archive']['sha256']
with tarfile.open(archive, 'r:gz') as bundle:
    if 'filesIndex' in manifest:
        index = manifest['filesIndex']
        data = bundle.extractfile(index['path']).read()
        assert len(data) == index['bytes']
        assert hashlib.sha256(data).hexdigest() == index['sha256']
        manifest['files'] = json.loads(data)['files'] + [index]
    members = bundle.getmembers()
    assert all(member.isfile() for member in members)
    assert sorted(member.name for member in members) == sorted(row['path'] for row in manifest['files'])
    bundle.extractall(sys.argv[1], filter='data')
for row in manifest['files']:
    data = (pathlib.Path(sys.argv[1])/row['path']).read_bytes()
    assert len(data) == row['bytes']
    assert hashlib.sha256(data).hexdigest() == row['sha256']
print(pathlib.Path(sys.argv[1])/root)
PYVERIFY
```

Supply the extracted capture/cache directories to the CLI documented above.
Required IFC fixtures and reference-engine dependencies are unchanged. Keep new
adjudication outputs separate; archived receipts must not be rewritten.
For another archive below, set `capture_manifest` to its `.manifest.json` path;
the recipe verifies its exact member names, including any revision prefix.

Derived browser/performance summaries and the native/performance archive indexes
are retained byte-for-byte in `validation-summaries.tar.gz`. First extract it with
`validation-summaries.manifest.json` using the recipe above. For either indexed
archive, then set `capture_manifest` to its extracted `.manifest.json` and rerun
the same block from the repository root. Recorded sources and limitations remain
unchanged; these historical records do not qualify later source.

## Historical native validation

`native-validation.tar.gz` retains the targeted native runs, sanctioned golden
regeneration, exact Python module provenance, independent source review and
workspace clippy for source commit `88f4a9f491`. Its decoded checksums and source
identity are in `native-validation.manifest.json`; use the extraction recipe
above with that manifest. The recorded lint-only patch bridges the native test
source to the final source without changing short-circuit evaluation order.
The old ISSUE_129 pin's diagnostic failure is preserved separately from its
successful stronger-pin rerun. This archive does not qualify later source,
browser geometry, performance, or required CI.

## Historical Chrome and finite-surface validation

`browser-validation.json` binds the source-built engine, real S_Office load,
and four reporter cases to their immutable captures and finite-surface oracle
receipts. All four agree on six finite faces at 100 µm.
`browser-validation.tar.gz` retains the raw geometry, reference diagnostics,
build receipts and screenshots; decoded checksums are in
`browser-validation.manifest.json`. Use the extraction recipe above with that
manifest. The original run's disposable-profile cleanup error remains recorded;
a separate strict-observation recovery proves the owned profile was retired
without rerunning captures or altering the protected browser. Browser Local
State and system-wide process observations remain local.

[Literal 2% case](screenshots/final-literal-2pct.png) ·
[Real S_Office model](screenshots/final-soffice.png)

## Final performance disposition

`performance-verdict.json` records **no qualified wall-time verdict**. The
native and browser campaigns remain refused or incomplete, including the
original cold-navigation observer failure. Their immutable receipts and the
observer correction are retained in `performance-validation.tar.gz`, with
decoded checksums in `performance-validation.manifest.json`. Host summaries
retain the original observation hashes and admission metrics; process and GPU
observations remain local. Use the manifest-selectable extraction recipe above.

The untimed native output check matches mesh counts and fingerprints for FZK and
Holter. ISSUE_129 changes geometry and reduces reported CSG failures. The existing
fingerprint excludes instancing, text, material definitions, UVs and textures;
timing fields in those raw outputs are unused. The CI record separately binds
its synthetic merge source and failing engine-size and geometry-instruction
ceilings. Neither a speed claim nor merge readiness follows from this evidence.

## Final test-cap isolation

The follow-up adds the shared budget-cap lock in two test paths only. All nine
transversal tests and exact workspace clippy pass; production source and frozen
runtime artifacts are unchanged. `test-lock-validation.tar.gz` preserves the
delta, source/artifact hashes and logs. Verify and extract it using
`test-lock-validation.manifest.json` with the recipe above.

## Budget-failure review follow-up

`budget-guard-validation.tar.gz` and its manifest retain the low-level batch
regression: two disjoint cutters cover the host, each oracle fits its budget,
but the exhausted batch incorrectly reports `Unchanged` before the fix. The
validator now rejects a pre-existing trip before opening oracle budgets. The
final unchanged-source regression and workspace clippy pass. Earlier build
errors and the separate mid-build test-name rename remain explicitly recorded.
The production void router already rejects budget trips; browser host loss is
not demonstrated. Earlier browser/performance evidence retains its original
source identity and does not qualify this later guard.

## Current review fixes

`review-followups.tar.gz` retains the zone regression failing after an actual
budget trip on the old implementation, 20 passing zone tests, and the separately
source-bound 67-test/Clippy run on `e5f4723829`. Its manifest works with the same
extraction recipe. The original scratch-parser failure remains recorded.

## Source-built engine and selected browser geometry

`current-engine-validation.tar.gz` binds the official WASM build and forced
viewer build at `440bb1f4f1` to engine SHA-256 `4bce6ba583225eb6feee1d352359c3c12f4590559cb9f2becd48dc14a8b15374`.
Its manifest seals both the archive and its internal decoded-file index; use
the same extraction recipe above. It preserves 144 files, including original
failed attempts, exact build/source/runtime maps, raw captures, screenshots,
oracle diagnostics, helper sources and a derived source bridge. Runtime binaries,
the frozen distribution, model fixtures and browser Local State are omitted.
The generated type change is Rustdoc only; production Rust is byte-identical
to the native-tested `e5f4723829` source.

Root typecheck covers 4,221 test files. The real WASM contract passes 204 tests
with one existing skip; public WASM tests pass 22. The initial consumer check's
missing installed dependencies and its failure remain separate from the
successful resumption after `pnpm install --frozen-lockfile`. Two symbolic
digests inherited from main's f64 RTC change (#7728/#7741) were regenerated
with this engine, then both tests passed without update mode; minimum primitive
counts are unchanged.

The Windows route uses Windows `node.exe` and native loopback CDP to a uniquely
owned Chrome profile. Extract `e/p/` for the launcher, capture sources and
generation receipts; `e/b/` holds the current raw records. The real S_Office
model loads first in a fresh context, through four WASM workers on physical
NVIDIA hardware. Four reporter/stacked captures follow. Every case records
the delivered runtime hashes and retained geometry bits. The original aggregate
still says `PRESERVED_FAILURE_OR_UNKNOWN` solely because its cleanup observation
failed. A separate invocation of the same strict helper verified no remaining
owned process, removed the disposable profile and preserved the protected
Chrome. The admission failure preceding this attempt is also retained. Neither
attempt is relabelled as a whole-browser protocol pass.

Independent fresh IfcOpenShell comparisons of the four completed raw reporter
records pass all six planes each at the unchanged 100 µm tolerance: no missing,
extra or unresolved coverage. The literal remainder is 0.025000095 m wide.
The source bridge additionally binds all four output-receipt hashes; reference
diagnostics were checked for terminal Boolean fallback. This is selected finite
surface adjudication, with the limitations stated above, not performance proof.

The current engine **fails** its transfer gate: 2,279,444 Brotli bytes against
2,243,651 allowed, or 35,793 bytes over. This comparison includes subsequent
main changes and does not isolate the PR's cost. A bounded read-only inspection
could not prove the proposed function-cloning cause; no compiler attribute or
acceptance limit was changed. No accepted worker-pool timing cohort exists.
Fresh CI and cross-platform determinism remain required before merge.

## Subsequent main integration

`main-integration-ffb96.tar.gz` and its manifest retain the integration of main
`ffb96cc393` into `1761202310`. Only the geometry module-size checksum required
manual resolution. The combined rows preserve both sides' stricter allowances;
independent review verifies all automatic merges and the composed checksum.
All 16 targeted tests (ratchet, reporter and local frame) and exact workspace
Clippy pass on the frozen merged source. Use the same extraction recipe above.
Earlier WASM, browser, performance and determinism proofs keep their recorded
source identities; they do not qualify this newer integration. Fresh CI remains
pending, and the earlier performance failures remain unresolved.

## Final 80bc validation scope

`final-80bc-validation.json` records actual validation of source
`80bc1bff690e307c82111cfb23edf7639bd40679`, not the later commit adding this
summary. Its native and consumer receipts bind the same source manifest and
production-tree checksum. All eight native stages pass: the signed-zero caller
regression, budget fixture, 121 issue-7292 unit tests, 18 mesh-bridge tests,
three public subtract-budget tests, eight module-ratchet tests, 17
function-ratchet tests (one ignored), and exact workspace/all-target Clippy.
The separate signed-zero run overlaps the 121-test selection; these are stage
counts, not a distinct-test total. No full workspace test sweep is claimed.

The official WASM build, root Turbo typecheck, real WASM contracts (210 passed,
one skipped), public WASM tests (22 passed), and forced viewer build complete.
The original qualification driver's post-WASM hold-label failure remains
failed; a separate continuation completed the remaining stages from the actual
source-built bytes. The engine transfer-size verdict remains **FAIL** and a
merge blocker.

A fresh owned Chrome capture binds that engine to five cases on physical NVIDIA
hardware. All six composite source/runtime/cleanup gates pass. Cleanup succeeds
on its first attempt under the unchanged two-attempt/60-second policy. Public
fields retain no protected-browser inventory or profile details. This functional
collector intercepts and fulfils actual responses to verify their delivered
bytes; its results make no performance claim.

The four reporter raw JSON files exactly match the earlier `8ae04cf8b8` oracle
inputs, including coordinate metadata. Exact fixture and comparator/helper pins,
`finite-coverage-v3`, and the unchanged 100 µm tolerance transfer those four
successful finite filled-surface proofs without rerunning the oracle. Each has
zero missing/extra area beyond tolerance and zero unresolved cells. This does
not prove closure, winding, multiplicity, volume or general CSG correctness.

The six selected S_Office typed mesh payloads match the earlier capture exactly;
their arrays, indices, transforms and local bounds pass the recorded structural
checks. Four actual geometry workers complete the load, with no recorded
GPU/page/network errors. Whole-scene bounds metadata differs, so whole-scene
identity is not claimed. The recorded populated-building and line-strip views
do not establish an occluded closeup or solid-volume oracle.

There is **no qualified end-to-end performance verdict**. The attempted browser
cohort accepts zero rows after a post-timing worker-response body-proof failure;
the native cohort accepts zero samples after host CPU admission refuses
0/12/1% observations against the unchanged 10% ceiling. Both attempts and their
failures remain separate from the successful functional capture.

The JSON supplies original receipt, log, raw-input, fixture and helper SHA-256
references. These identify locally retained evidence; this addition does not
publish those originals, add a new archive, or extend any historical archive.
Unpublished originals cannot be independently retrieved or replayed from hashes
alone. No new screenshots or raw bundles are included. Required hosted CI,
cross-platform determinism and merge readiness are outside this summary.

The initial-publication CI oracle uses `signed-zero.oracle.patch` because a
whole-production revert removes new Rust APIs and cannot compile the changed
tests. The harness reverse-applies this forward fix to restore the exact
pre-fix SourceAxes registration/lookup behavior while retaining modules, types
and every test. The existing caller regression fails behaviorally before the
fix and passes on `80bc`. At `b858a01`, hosted CI completed all 34 derived
runnable plans on both sides ([CI run](https://github.com/LTplus-AG/ifc-lite/actions/runs/38983590104)).
There were 300/300 baseline passes, and the reverted
side had 299 passes and the expected signed-zero failure. Selection, timeout,
classification and restoration checks were unchanged; one helper collected no
tests and six golden capability gaps were disclosed. The retained JSON log
prefix is truncated, so it is not a complete machine ledger. The human verdict,
phase counts and successful source restoration are retained. This seam witness
does not establish exhaustive mutation coverage of the entire change. Whole-change
reversion resumes once the module is on main.
