# Mesh owner cache and renderer packing evidence (#6537)

The source-matched public-model loads were driven through the actual T3 shared
browser and the canonical viewer file input. No scheduler, loader or producer
was replaced. Source, build, runtime and fixture hashes are retained with every
sample or provenance record. The unchanged WASM runtime is newer than the Rust
sources in both final builds.

## Verdict and limits

The direct renderer packing candidate remains unshipped: these measurements do
not demonstrate an end-to-end benefit. The owner-cache candidate removes
repeated prefix stamping and preserves released-buffer semantics, but no normal
foreground speed improvement is established. Both experiments retain their
negative and noisy samples. The original packing verdict predates the frame
cadence diagnostic below and must be read with that limitation.

The identical animation-frame sampler in the third Holter owner-cache pair
found approximately one frame per second on both builds. An empty viewer has
the same cadence, while the preparation page receives frequent frames. The T3
preview reports hidden even though document visibility reports visible. The
adapter is a real NVIDIA device, not a fallback. A long post-stream queue tail
in this environment cannot identify product main-thread/GPU CPU cost or stand
in for foreground user readiness. Verify actual foreground frame cadence
before further timing qualification. No instanced GPU byte hash is claimed.

Retained flat-mesh positions, normals, indices and appearance fingerprints
match for the small AC20, CSG-heavy Holter and larger O-S1 inputs. GPU residency
allocation totals vary on unchanged code too; they are not a byte oracle.
Source buffers and stable owner indices are verified independently by mounted
hook tests, including immutable replacements, point-cloud chunks, model count
and visibility transitions, and the actual store CPU-release action.

## Inspect the raw records

`raw-observations.json.gz` is a deterministic gzip archive of records with
original name, SHA-256, byte count and parsed JSON value. The manifest is
readable without decompression. It preserves the initial packing samples and
the partial owner-cache A/B series; neither is a complete representative
foreground performance verdict. The frame-sampler pair is explicitly distinct
from earlier samples without that sampler. No baseline file was overwritten.

```python
import gzip, json
from pathlib import Path
records = json.loads(gzip.decompress(Path("raw-observations.json.gz").read_bytes()))
for record in records:
    print(record["name"], record["value"].get("geometry"))
```

Original JSON whitespace is represented by its hash; the archive stores each
parsed value losslessly. Source worktree paths are capture-time provenance,
not required install paths. Performance ledger conclusions are narrative;
these records contain the measured values and their qualifications.


## Independent base reproduction of the memory defect

The actual base hook and owner helper were restored together in an owned
worktree while running the new mounted tests through root Turbo. Seven tests
passed and two failed: single-model appends copied the prefix again, and a
federation retained buffers after the canonical store release action. The
base single-model release case passed, narrowing the pre-existing memory
defect to the federated cache. Restoring both candidate files byte-for-byte
makes all nine tests pass, without a geometry-content version bump that would
request a GPU reupload of released arrays. Both real logs are archived. This
is correctness evidence independent of the unqualified browser timings.


## Batched release and retained aliases

Independent review reproduced a release followed by append in the same React
batch: the original same-length trigger misses the release. A forced rebuild
then exposed a second defect: appending to an earlier federation owner reorders
the global prefix already consumed by the uploader. Replacement, recolor and
clear actions also exposed retained wrappers that were discarded before their
CPU arrays could be emptied. The three genuine failing runs and subsequent
passes are retained in `release-regression-logs.json.gz`, with original hashes
and exact counts in `release-regression-manifest.json`.

The correction uses one canonical CPU-release primitive and a weak source-array
revision. The hook checks its previous sources and empties their previous owner
wrappers before replacement or teardown can discard them. A release followed
by append keeps the global prefix and adds only the new suffix. Retained counts
and appearance provenance survive repeated releases; GPU content version stays
unchanged. Mounted tests cover single and federated models, successive releases,
recolor, peer replacement and clearing the federation. These are correctness
claims, independent of any timing result.

The corrected source was integrated with base `3e2779997ae165c36f6939419f9229debc73c163`
and built as `ffa087d031df2f48d57fd216aa8d00b783dfd8c4`. Full root build and
typecheck passed, followed by the streaming, federation, translation, data-slice
and memory suites. Both comparison builds have byte-identical WASM runtime,
glue and committed types. The earlier hidden-preview observations remain
retained and are not promoted to a foreground performance verdict.
