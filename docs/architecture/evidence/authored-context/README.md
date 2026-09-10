# Shared authored context (#4406)

This prerequisite extracts the existing source/metadata/placement setup and
fixed-row author from the common annotation/captured-object planner. The public
APIs, fixed entity layouts, texture construction and canonical mesh production
stay in the existing creator path. Metadata validation still precedes image URI
validation. It enables later geometry representations to reuse source context
without supplying an image URI or adding another STEP writer.

Two independently rebuilt WASM modules from exact base `c638bdca7` and branch
`e81472165` produced byte-identical complete plan buffers for all 24 controls in
`plan-identity.json`. The comparison includes ordered IFC rows, canonical mesh
arrays, placement, UV seams and all sampler combinations, across IFC4/IFC4X3
and metres/millimetres. Horizontal and vertical image annotation frames are
covered. These are full buffer comparisons, not just mesh-count checks.

Full native workspace and strict workspace/all-target clippy passed. Existing
appearance tests passed, the root build passed, and actual WASM contracts
passed with their existing optional fixture skips. A fresh independently
installed PyO3 wheel matched all four committed quick-lane IFC references;
the existing halfspace triangle-density advisory remains.
