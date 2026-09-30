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
