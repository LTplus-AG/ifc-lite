// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#![no_main]

use ifc_lite_geometry::kernel::mesh_bridge::subtract;
use ifc_lite_geometry::Mesh;
use libfuzzer_sys::fuzz_target;

// The pure-Rust exact CSG kernel (rust/geometry/src/kernel/) is the only
// boolean kernel on every target since M9, and it sits on the hot path for
// EVERY void cut in the pipeline (see rust/AGENTS.md: "opening voids = ONE
// exact cut"). Real hosts/cutters come from tessellated IFC geometry and can
// be non-manifold, non-watertight, or degenerate (zero-area triangles,
// duplicate vertices, NaN/Inf positions from a malformed export).
// `mesh_bridge::mesh_to_tris` documents itself as panic-free (drops
// out-of-range indices and non-finite coordinates rather than indexing past
// the end); this target continuously fuzzes that contract, plus everything
// downstream of it (orient_outward, promote_cutter_verts_onto_host_faces,
// the arrangement/boolean pipeline).
//
// Meshes are built as a flat triangle soup (indices = 0..n, one triangle per
// 3 vertices) rather than valid solids on purpose: arbitrary, not
// well-formed, input is the point of fuzzing the kernel boundary. Capped at a
// handful of triangles per side so an iteration stays fast — the kernel's
// arrangement step is superlinear in triangle count.
const MAX_TRIS_PER_MESH: usize = 8;

fn mesh_from_bytes(data: &[u8]) -> Mesh {
    let mut positions = Vec::with_capacity(MAX_TRIS_PER_MESH * 9);
    for chunk in data.chunks_exact(4).take(MAX_TRIS_PER_MESH * 9) {
        positions.push(f32::from_le_bytes(chunk.try_into().expect("4-byte chunk")));
    }
    // Truncate to a whole number of triangles (3 verts * 3 coords each).
    let tri_count = positions.len() / 9;
    positions.truncate(tri_count * 9);

    let mut mesh = Mesh::new();
    mesh.indices = (0..(tri_count * 3) as u32).collect();
    mesh.positions = positions;
    mesh
}

// Contract under fuzz: `host - cutter` over two arbitrary (not necessarily
// watertight or manifold) triangle soups must never panic, hang, or overflow
// the stack. The returned Mesh is intentionally discarded; libFuzzer drives
// input coverage.
fuzz_target!(|data: &[u8]| {
    let mid = data.len() / 2;
    let host = mesh_from_bytes(&data[..mid]);
    let cutter = mesh_from_bytes(&data[mid..]);
    let _ = subtract(&host, &cutter);
});
