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

## Final native validation

`native-validation.tar.gz` retains the targeted native runs, sanctioned golden
regeneration, exact Python module provenance, independent source review and
workspace clippy for source commit `88f4a9f491`. Its decoded checksums and source
identity are in `native-validation.manifest.json`; use the extraction recipe
above with that manifest. The recorded lint-only patch bridges the native test
source to the final source without changing short-circuit evaluation order.
The old ISSUE_129 pin's diagnostic failure is preserved separately from its
successful stronger-pin rerun. This archive does not qualify later source,
browser geometry, performance, or required CI.

## Final Chrome and finite-surface validation

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
