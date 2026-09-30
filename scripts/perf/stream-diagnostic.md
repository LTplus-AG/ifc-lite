# Private-model streaming diagnostics

`stream-diagnostic.mjs` investigates #6516 without sending the IFC file anywhere.
Run it from the directory containing the project's installed packages. It resolves
the geometry entry there and the WASM binary **from geometry's own dependency
tree**, then records both versions and the binary digest. This matters when npm
has installed multiple WASM versions.

```sh
node /path/to/stream-diagnostic.mjs client.ifc > report.json
node /path/to/stream-diagnostic.mjs client.ifc --profile > profile-summary.json
```

The first load follows `GeometryProcessor.processStreaming` and measures the
whole stream after `init`, matching the issue's boundary. Per-batch waits identify
whether time is concentrated in a few batches; they do not attribute it to a
particular opening. A separate untimed load computes a SHA-256 digest over each
mesh's positions, normals, indices, origin, color and Express ID. Mesh hashes are
sorted before aggregation, so a different stream order alone does not change it.
This checks those exact output bytes, rather than asserting geometry equivalence
from an unchanged mesh count. It does not fingerprint textures or other metadata.
Both processors are disposed even on failure, and iterator abandonment runs the
canonical loader's cleanup.

The optional inspector profile reports sampled **self time**, aggregated across
call stacks, with WASM function indices/offsets and a binary digest to identify
the artifact. Script/inspector overhead is reported separately. It strips source
URLs and authored function names; JavaScript time is combined into one category.
This is coarse attribution, not a source-level explanation or benchmark verdict.
Profiling perturbs timing: compare unprofiled runs for performance.

The shareable JSON contains no filename, absolute path, entity coordinates or
raw CPU profile. Library console output is counted by level and withheld because
it may contain client metadata. If the diagnostic fails, the CLI exits nonzero
and withholds model-specific error text. The normal load's warning/error counters
must still be considered when interpreting a successful report. The counts also
include the separate verification load.

For the release boundary in #6516, use separate temporary npm projects with
exact dependencies, rather than replacing dependencies in the application:

```sh
# In one empty temporary directory:
npm init -y
npm install --ignore-scripts --save-exact @ifc-lite/geometry@6.0.0 @ifc-lite/wasm@8.0.1 @ifc-lite/data@4.2.1

# In a different empty temporary directory:
npm init -y
npm install --ignore-scripts --save-exact @ifc-lite/geometry@7.0.0 @ifc-lite/wasm@9.0.0 @ifc-lite/data@4.4.0
```

Run unprofiled measurements alternately from both directories in fresh Node
processes on an otherwise idle machine. Keep every result and compare at least
five pairs. Then collect one profile per installation. Share the generated JSON,
not the private IFC or a raw inspector profile. Keep the reported package and
binary identities with the measurements. A digest difference means output bytes
changed and the timings are not a byte-identical comparison; it does not by
itself establish a geometry defect.

Functional validation used the committed `issue_098_wall_V5C.ifc` fixture:
both pinned release pairs emit matching mesh bytes and counts through the
ordinary streaming path. This public seven-non-rectangular-opening fixture did
not reproduce the private model's slowdown or failures. Neither the script nor
that observation resolves #6516. No opening bypass or production routing change
is included.
