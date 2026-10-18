# Section-plane export evidence (#7711)

This packet records a completed measurement and current functional qualification;
it does **not** assert merge readiness. Implementation is PR #7900; this evidence
is in its qualification stack, PR #7908. The parent owns monitoring and ordered
landing. No issue closure or merge is requested.

The measured aggregate commit is `4bf77c6566a9aca84acd1d67c28273525de2f2e9`,
tree `cd5e29e2c8ddbb2a4dc529b6096510f0b66b7cd4`; its base is
`c53cfaa3a2034638f4c4ab40f7674b29e0528fed`. Subsequent evidence/ledger-only
commits preserve that runtime and production source. They do not turn an earlier
run into a test of a new executable tree.

## Read the packet

[artifact-index.json](artifact-index.json) identifies every retained archive
member by size and SHA256. `retained-evidence.tar.gz` preserves the original bytes
of numeric samples, commands, receipts, driver snapshots, input closure,
pre/post guards, functional output receipts and hosted failure logs.
[summary.json](summary.json) is a lossless copy of the completed post-run integrity
report, with the numerical summaries kept as data rather than a numeric baseline.
The archive contains no IFC fixture, generated WASM runtime or native binary;
their exact hashes and the public source/fixture pins are retained.

Verify and read members without running a build or benchmark:

```python
import hashlib, json, tarfile
from pathlib import Path
root = Path("scripts/perf/evidence/section-export-7711")
index = json.loads((root / "artifact-index.json").read_text())
archive = root / index["archive"]["path"]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == index["archive"]["sha256"]
with tarfile.open(archive, "r:gz") as bundle:
    for member in index["members"]:
        payload = bundle.extractfile(member["path"]).read()
        assert len(payload) == member["bytes"]
        assert hashlib.sha256(payload).hexdigest() == member["sha256"]
    export = json.load(bundle.extractfile("measurement/measured-export-result.json"))
    print(export["summary"])
```

## What was observed

Benchmark job `67a3deb5-1847-4581-89da-0f1840eb9c6f` completed successfully on
Pop with clean, unchanged source. The original frozen direct-binary driver and
prepared JavaScript bundles were used; no Cargo, build or install ran inside the
exclusive reservation. Input hashes and AC/thermal guards passed before/after.
Each native FZK, ISSUE_129 and Holter permutation retains all wall-time samples,
fingerprints and counts. **Both native binaries are identical: controls only.**
Actual base/branch StepExporter samples preserve canonical STEP DATA identity.
The new public trim operation is measured separately and has no equivalent base
operation. Its timing is not a speedup comparison. The raw trim DATA hashes are
stable across its samples; those timed outputs were not separately run through
the independent oracle.

The real Chrome CPU/WASM FZK export/reopen and independent IfcOpenShell check
have their own archived receipts bound to the actual browser output hash.
That oracle checks world bounds, identities and semantic/opening links, not
watertight caps, colours or full EXPRESS validity. Caps/colours are covered by
native and real-WASM regressions. The browser witness is a public-API harness,
not a product viewport or GPU performance cohort. IFC fixtures remain in the
normal fetched fixture catalog; the generated browser IFC remains in the retained
local evidence, identified by its receipt hash.

## Qualification still held

`qualification/hosted-current-blockers.json` and the original hosted logs retain
all observed blockers: causal witness `REVERT-BROKE-BUILD`, stale generated
StepLog tables, viewer shard 11's placement-bound assertion, failed viewer
entry/eager bundle ceilings, and a skipped review with no verdict. These are not
waived by the local export measurements. No base reproduction, repair or passing
replacement run is claimed for those failures.

Existing ordinary PC job `04fee2d7-0093-4683-9ef9-b80f1fc23806` remains queued
at packet capture. It owns the missing leaf declaration preparation and actual
current API/docs/root-lint gates, including the main-entry guard. The earlier
missing-declaration environment failure is retained. Historical docs/lint passes
are not promoted to current-source passes. No replacement job was submitted.
