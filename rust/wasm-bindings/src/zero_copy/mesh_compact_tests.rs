// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::{MeshCollection, MeshDataJs};
use super::*;
use ifc_lite_geometry::Mesh;

/// A flat-shaded axis box (24 corners, 12 triangles) of size `s` at `origin`
/// (IFC Z-up input; `MeshDataJs::new` swaps to Y-up).
fn flat_box(id: u32, origin: [f64; 3], s: f32) -> MeshDataJs {
    let faces: [([f32; 3], [[f32; 3]; 4]); 6] = [
        ([0.0, 0.0, -1.0], [[0.0, 0.0, 0.0], [s, 0.0, 0.0], [s, s, 0.0], [0.0, s, 0.0]]),
        ([0.0, 0.0, 1.0], [[0.0, 0.0, s], [s, 0.0, s], [s, s, s], [0.0, s, s]]),
        ([0.0, -1.0, 0.0], [[0.0, 0.0, 0.0], [s, 0.0, 0.0], [s, 0.0, s], [0.0, 0.0, s]]),
        ([0.0, 1.0, 0.0], [[0.0, s, 0.0], [s, s, 0.0], [s, s, s], [0.0, s, s]]),
        ([-1.0, 0.0, 0.0], [[0.0, 0.0, 0.0], [0.0, s, 0.0], [0.0, s, s], [0.0, 0.0, s]]),
        ([1.0, 0.0, 0.0], [[s, 0.0, 0.0], [s, s, 0.0], [s, s, s], [s, 0.0, s]]),
    ];
    let mut mesh = Mesh::default();
    for (n, quad) in faces {
        let base = (mesh.positions.len() / 3) as u32;
        for p in quad {
            mesh.positions.extend_from_slice(&p);
            mesh.normals.extend_from_slice(&n);
        }
        mesh.indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    mesh.origin = origin;
    MeshDataJs::new(id, "IfcWall".to_string(), mesh, [0.5, 0.25, 0.75, 1.0])
}

#[test]
fn salt_and_oct_match_the_renderer() {
    assert_eq!(color_salt(&[1.0, 0.0, 0.0, 1.0]), 163);
    assert_eq!(color_salt(&[0.5, 0.25, 0.75, 1.0]), 201);
    assert_eq!(color_salt(&[0.8, 0.8, 0.8, 1.0]), 124);
    // octEncode(0,0,-1) -> (255,255); (0,1,0) -> (128,255).
    assert_eq!(oct_encode(0.0, 0.0, -1.0), 0xFFFF);
    assert_eq!(oct_encode(0.0, 1.0, 0.0), (128 << 8) | 255);
}

#[test]
fn a_flat_box_welds_to_eight_vertices() {
    let mut c = MeshCollection::new();
    c.add(flat_box(7, [1.0, 2.0, 3.0], 1.0));
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 1);
    assert_eq!(b.records.len(), 8 * 12);
    assert_eq!(b.indices.len(), 36);
    assert_eq!(b.totals, [24.0, 12.0, 8.0, 12.0]);
    // Y-up world bounds: origin (1,2,3) Z-up -> (1,3,-2); box spans y in [3,4], z in [-3,-2].
    assert_eq!(b.bounds, vec![1.0, 3.0, -3.0, 2.0, 4.0, -2.0]);
    // Every lane carries the id and the salt.
    for r in b.records.chunks_exact(12) {
        assert_eq!(u32::from_le_bytes([r[8], r[9], r[10], r[11]]), 7 | (201 << 24));
    }
    // Dequantized positions are the corners, exactly (they lie on the lattice).
    let cell_q = 32 * 1024;
    for r in b.records.chunks_exact(12) {
        for axis in 0..3 {
            let q = u16::from_le_bytes([r[axis * 2], r[axis * 2 + 1]]) as f64;
            let world = (b.windows[axis] + q) * step_of(b.table[5]);
            assert!(world == b.bounds[axis] || world == b.bounds[axis + 3]);
        }
    }
    assert_eq!(b.windows[0] as i64, -cell_q / 2);
    assert_eq!(b.table[5], BASE_LEVEL);
    // The encoded mesh's arrays were taken.
    assert!(c.meshes[0].positions.is_empty() && c.meshes[0].indices.is_empty());
}

#[test]
fn averaged_normals_point_outward() {
    let mut c = MeshCollection::new();
    c.add(flat_box(1, [0.0, 0.0, 0.0], 2.0));
    let b = c.encode_compact(32.0);
    for r in b.records.chunks_exact(12) {
        let oct = u16::from_le_bytes([r[6], r[7]]);
        // A corner's averaged normal has |component| ~ 1/sqrt(3) on every axis,
        // so neither byte sits at the centre (128) of its range.
        assert_ne!(oct >> 8, 128);
        assert_ne!(oct & 0xFF, 128);
    }
}

#[test]
fn oversized_and_textured_meshes_stay_on_the_f32_path() {
    let mut c = MeshCollection::new();
    c.add(flat_box(1, [0.0, 0.0, 0.0], 200.0));
    let mut textured = flat_box(2, [0.0, 0.0, 0.0], 1.0);
    textured.uvs = vec![0.0; 48];
    c.add(textured);
    c.add(flat_box(3, [0.0, 0.0, 0.0], 1.0));
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 1);
    assert_eq!(b.table[0], 2);
    assert_eq!(b.refusals[Refusal::Extent as usize], 1);
    assert_eq!(b.refusals[Refusal::Textured as usize], 1);
    assert_eq!(c.meshes[0].positions.len(), 72);
}

#[test]
fn a_batch_is_sorted_by_cell_then_colour() {
    let mut c = MeshCollection::new();
    c.add(flat_box(1, [100.0, 0.0, 0.0], 1.0));
    c.add(flat_box(2, [0.0, 0.0, 0.0], 1.0));
    c.add(flat_box(3, [101.0, 0.0, 0.0], 1.0));
    let b = c.encode_compact(32.0);
    let order: Vec<u32> = b.table.chunks_exact(TABLE_STRIDE).map(|r| r[0]).collect();
    assert_eq!(order, vec![1, 0, 2]);
}

#[test]
fn a_thin_rod_moves_to_a_finer_lattice() {
    // A 0.4 mm square bar, 0.9 m long: on the 1 mm lattice its cross-section
    // collapses; it must encode at a finer level instead of being refused.
    let mut c = MeshCollection::new();
    let mut rod = flat_box(5, [0.3, 0.2, 0.1], 0.0004);
    for (k, p) in rod.positions.iter_mut().enumerate() {
        if k % 3 == 1 && *p > 0.0 { *p = 0.9; } // stretch one axis
    }
    c.add(rod);
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 1, "refusals {:?}", b.refusals);
    assert!(b.table[5] > BASE_LEVEL, "level {}", b.table[5]);
}

#[test]
fn a_wide_slab_moves_to_a_coarser_lattice() {
    let mut c = MeshCollection::new();
    c.add(flat_box(9, [0.0, 0.0, 0.0], 80.0));
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 1, "refusals {:?}", b.refusals);
    assert_eq!(b.table[5], COARSER_LEVEL);
}

/// A sheet modelled with both of its sides (same positions, opposite normals), as IFC roofs and glazing
/// often are. Welding the two sides into one vertex would store a cancelled normal, and the shader's
/// face-normal sign would be noise: the two sides must stay apart, each with a normal on its own side.
#[test]
fn the_two_sides_of_a_sheet_are_not_welded_together() {
    let quad = [[0.0f32, 0.0, 0.0], [4.0, 0.0, 0.0], [4.0, 3.0, 1.0], [0.0, 3.0, 1.0]];
    let len = (1.0f32 + 9.0).sqrt();
    let up = [0.0f32, -1.0 / len, 3.0 / len];
    let mut mesh = Mesh::default();
    for (n, order) in [(up, [0u32, 1, 2, 0, 2, 3]), ([-up[0], -up[1], -up[2]], [0, 2, 1, 0, 3, 2])] {
        let base = (mesh.positions.len() / 3) as u32;
        for p in quad {
            mesh.positions.extend_from_slice(&p);
            mesh.normals.extend_from_slice(&n);
        }
        mesh.indices.extend(order.iter().map(|i| base + i));
    }
    let mut c = MeshCollection::new();
    c.add(MeshDataJs::new(7, "IfcRoof".to_string(), mesh, [0.7, 0.3, 0.2, 1.0]));
    let b = c.encode_compact(32.0);
    assert_eq!(b.table[2], 8, "four corners per side");
    assert_eq!(b.table[4], 12, "both sides keep their triangles");
    let octs: Vec<u16> = b.records.chunks_exact(12).map(|r| u16::from_le_bytes([r[6], r[7]])).collect();
    let distinct: std::collections::BTreeSet<u16> = octs.iter().copied().collect();
    assert_eq!(distinct.len(), 2, "one stored normal per side, never a cancelled sum: {octs:?}");
    assert!(!distinct.contains(&oct_encode(0.0, 0.0, 0.0)));
}

/// The split is paid only where corners oppose: a box still welds to its eight corners.
#[test]
fn a_box_is_not_split() {
    let mut c = MeshCollection::new();
    c.add(flat_box(1, [0.0, 0.0, 0.0], 2.0));
    assert_eq!(c.encode_compact(32.0).table[2], 8);
}

/// Every source vertex decodes to within half a lattice step of itself on each axis: the precision the
/// module documents (0.49 mm at level 10), on coordinates that do not lie on the lattice.
#[test]
fn a_decoded_vertex_is_within_half_a_step_of_its_source() {
    let mut mesh = flat_box(3, [12.3456789, -4.987654321, 7.0001234], 1.2345678);
    for (k, p) in mesh.positions.iter_mut().enumerate() {
        *p += 0.000_137 * (k % 7) as f32;
    }
    let source: Vec<[f64; 3]> = mesh
        .positions
        .chunks_exact(3)
        .map(|p| [mesh.origin[0] + p[0] as f64, mesh.origin[1] + p[1] as f64, mesh.origin[2] + p[2] as f64])
        .collect();
    let mut c = MeshCollection::new();
    c.add(mesh);
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 1, "refusals {:?}", b.refusals);
    let step = step_of(b.table[5]);
    let decoded: Vec<[f64; 3]> = b
        .records
        .chunks_exact(12)
        .map(|r| std::array::from_fn(|axis| (b.windows[axis] + u16::from_le_bytes([r[axis * 2], r[axis * 2 + 1]]) as f64) * step))
        .collect();
    for p in &source {
        let nearest = decoded
            .iter()
            .map(|d| (0..3).map(|axis| (d[axis] - p[axis]).abs()).fold(0.0, f64::max))
            .fold(f64::INFINITY, f64::min);
        assert!(nearest <= step / 2.0, "{p:?} decodes {nearest} m away, step {step}");
    }
    // The box rides along in f64 and contains every decoded vertex to the same bound.
    for d in &decoded {
        for (axis, v) in d.iter().enumerate() {
            assert!(*v >= b.bounds[axis] - step / 2.0 && *v <= b.bounds[axis + 3] + step / 2.0);
        }
    }
}

/// The 12-byte record IS the contract with the renderer's quantized vertex layout (`quantize.ts`):
/// u16 x, y, z, then `(octX << 8) | octY`, then the u32 lane, little-endian.
#[test]
fn the_record_layout_is_the_renderers_quantized_vertex() {
    let mut c = MeshCollection::new();
    c.add(flat_box(7, [0.0, 0.0, 0.0], 1.0));
    let b = c.encode_compact(32.0);
    // The window starts half a cell (16 m = 16384 steps) below cell 0; the first source vertex is the origin.
    let first = &b.records[..12];
    let q: Vec<u16> = (0..3).map(|a| u16::from_le_bytes([first[a * 2], first[a * 2 + 1]])).collect();
    assert_eq!(b.windows[..3], [-16384.0, -16384.0, -16384.0]);
    assert_eq!(q, [16384, 16384, 16384]);
    assert_eq!(u32::from_le_bytes([first[8], first[9], first[10], first[11]]), 7 | (201 << 24));
    assert_eq!(b.indices.iter().copied().max(), Some(7));
}

#[test]
fn meshes_the_encoder_cannot_take_are_refused_untouched() {
    let mut c = MeshCollection::new();
    let mut no_normals = flat_box(1, [0.0, 0.0, 0.0], 1.0);
    no_normals.normals.clear();
    c.add(no_normals);
    let mut bad_index = flat_box(2, [0.0, 0.0, 0.0], 1.0);
    bad_index.indices[4] = 999;
    c.add(bad_index);
    c.add(flat_box(0x0100_0000, [0.0, 0.0, 0.0], 1.0));
    let mut not_finite = flat_box(4, [0.0, 0.0, 0.0], 1.0);
    not_finite.positions[5] = f32::NAN;
    c.add(not_finite);
    // Every triangle repeats a vertex after welding: nothing left to draw.
    let mut point = flat_box(5, [0.0, 0.0, 0.0], 1.0);
    point.positions.iter_mut().for_each(|p| *p = 0.25);
    c.add(point);
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 0);
    for kind in [Refusal::Normals, Refusal::IndexRange, Refusal::IdRange, Refusal::NonFinite, Refusal::Empty] {
        assert_eq!(b.refusals[kind as usize], 1, "{kind:?} in {:?}", b.refusals);
    }
    for mesh in &c.meshes {
        assert_eq!(mesh.positions.len(), 72, "a refused mesh keeps its arrays");
        assert_eq!(mesh.indices.len(), 36);
    }
}

/// Corners that no split by side can witness (normals fanning more than 90 degrees apart inside one
/// dominant-axis class) must refuse the mesh instead of storing a normal on the wrong side.
#[test]
fn a_node_no_stored_normal_can_witness_refuses_the_mesh() {
    let mut mesh = Mesh::default();
    // Twelve triangles share the apex; one faces (+x,+y,+z), eleven face (+x,-y,-z). All are in the
    // +x class, and the sum of the twelve is on the far side of the first.
    let fan: Vec<[f32; 3]> = std::iter::once([0.58f32, 0.57, 0.57]).chain(std::iter::repeat_n([0.58, -0.57, -0.57], 11)).collect();
    for (k, n) in fan.iter().enumerate() {
        let base = (mesh.positions.len() / 3) as u32;
        let k = k as f32;
        for p in [[0.0f32, 0.0, 0.0], [1.0 + k, 2.0, 0.5], [1.0 + k, 2.5, 1.5]] {
            mesh.positions.extend_from_slice(&p);
            mesh.normals.extend_from_slice(n);
        }
        mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    let mut c = MeshCollection::new();
    c.add(MeshDataJs::new(11, "IfcBuildingElementProxy".to_string(), mesh, [0.5, 0.5, 0.5, 1.0]));
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 0);
    assert_eq!(b.refusals[Refusal::Normals as usize], 1, "{:?}", b.refusals);
    assert_eq!(c.meshes[0].positions.len(), 108);
}

#[test]
fn a_cell_size_outside_the_window_encodes_nothing() {
    // 0.0015 and 32.0001 would snap into range; the argument itself is what is judged.
    for cell in [0.0, -1.0, f64::NAN, f64::INFINITY, 0.0001, 0.0015, 32.0001, 32.5, 64.0] {
        let mut c = MeshCollection::new();
        c.add(flat_box(1, [0.0, 0.0, 0.0], 1.0));
        let b = c.encode_compact(cell);
        assert_eq!(b.mesh_count(), 0, "cell {cell}");
        assert_eq!(b.refusals, [0; REFUSAL_KINDS]);
        assert_eq!(c.meshes[0].positions.len(), 72, "cell {cell}");
    }
    // The cell size snaps to the base lattice, so an off-lattice size still encodes.
    let mut c = MeshCollection::new();
    c.add(flat_box(1, [40.0, 0.0, 0.0], 1.0));
    assert_eq!(c.encode_compact(10.0003).mesh_count(), 1);
}

/// Encoding is a pure function of the collection: the same input gives the same bytes, whatever the
/// scratch held before (the scratch is reused across the meshes of a batch).
#[test]
fn encoding_is_deterministic_across_batch_composition() {
    let alone = {
        let mut c = MeshCollection::new();
        c.add(flat_box(4, [3.3, 1.1, 2.2], 0.7));
        c.encode_compact(32.0)
    };
    let mut c = MeshCollection::new();
    c.add(flat_box(9, [0.0, 0.0, 0.0], 80.0)); // coarser level first: a different window and scratch state
    c.add(flat_box(4, [3.3, 1.1, 2.2], 0.7));
    let b = c.encode_compact(32.0);
    let row = b.table.chunks_exact(TABLE_STRIDE).position(|r| r[0] == 1).expect("the small box encodes");
    let t = &b.table[row * TABLE_STRIDE..][..TABLE_STRIDE];
    assert_eq!(&b.records[t[1] as usize * 12..][..t[2] as usize * 12], &alone.records[..]);
    assert_eq!(&b.indices[t[3] as usize..][..t[4] as usize], &alone.indices[..]);
    assert_eq!(&b.windows[row * 3..][..3], &alone.windows[..]);
    assert_eq!(&b.bounds[row * 6..][..6], &alone.bounds[..]);
}

/// A mesh far past the u16 index range is refused without the weld table growing with it.
#[test]
fn a_huge_mesh_is_refused_with_a_bounded_weld_table() {
    let mut mesh = Mesh::default();
    let side = 400u32; // 160,000 distinct lattice nodes
    for i in 0..side {
        for j in 0..side {
            mesh.positions.extend_from_slice(&[i as f32 * 0.01, j as f32 * 0.01, 0.0]);
            mesh.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
    }
    for i in 0..side - 1 {
        for j in 0..side - 1 {
            let a = i * side + j;
            mesh.indices.extend_from_slice(&[a, a + side, a + 1, a + 1, a + side, a + side + 1]);
        }
    }
    let mesh = MeshDataJs::new(1, "IfcGeographicElement".to_string(), mesh, [0.4, 0.6, 0.3, 1.0]);
    let bounds = frame_bounds(&mesh).unwrap();
    let mut scratch = Scratch::default();
    assert_eq!(fit_mesh(&mesh, &bounds, 32 * 1024, &mut scratch).err(), Some(Refusal::WeldedVertices));
    assert!(scratch.weld_slots() <= 1 << 17, "{} slots", scratch.weld_slots());
}

/// A mesh that collapses on the base lattice and fits no finer window is counted as a collapse, the
/// reason it left the base level, not as too wide.
#[test]
fn a_collapse_no_finer_level_holds_is_reported_as_a_collapse() {
    // A 0.4 mm square bar, 40 m long, on the lattice: its cross-section collapses at level 10 (0.41
    // steps), and the level-11 window is only 32 m wide.
    let mut c = MeshCollection::new();
    let mut rod = flat_box(5, [0.0, 0.0, 0.0], 0.0004);
    for (k, p) in rod.positions.iter_mut().enumerate() {
        if k % 3 == 0 && *p > 0.0 { *p = 40.0; }
    }
    c.add(rod);
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 0);
    assert_eq!(b.refusals[Refusal::Collapse as usize], 1, "{:?}", b.refusals);
    assert_eq!(b.refusals[Refusal::Extent as usize], 0);
}

/// The in-place sort orders any permutation exactly as the standard sort does.
#[test]
fn sort_indices_matches_the_standard_sort() {
    for n in [0usize, 1, 2, 3, 17, 257] {
        // Keys with many ties, visited in a scrambled order; the index breaks ties.
        let keys: Vec<u32> = (0..n as u32).map(|i| i.wrapping_mul(2_654_435_761) % 7).collect();
        let mut order: Vec<u32> = (0..n as u32).map(|i| (i * 101 + 13) % n.max(1) as u32).collect();
        if n == 257 {
            let distinct: std::collections::BTreeSet<u32> = order.iter().copied().collect();
            assert_eq!(distinct.len(), n, "the scramble is a permutation");
        }
        let mut expected = order.clone();
        expected.sort_by_key(|&i| (keys[i as usize], i));
        weld::sort_indices(&mut order, |a, b| (keys[a as usize], a) < (keys[b as usize], b));
        assert_eq!(order, expected, "n = {n}");
    }
}

/// A node is the rounded f64 `origin + position`, the value the bounds are formed from, so a point
/// shared by meshes with different origins lands on one node. Folding the origin into a per-mesh
/// base first rounds differently next to a tie: here it would put the far corner one step off.
#[test]
fn a_node_is_the_rounded_sum_of_origin_and_position() {
    let tie = 0.499_999_999_9 / 1024.0;
    let mut mesh = flat_box(1, [tie; 3], 1.0);
    mesh.positions.iter_mut().for_each(|p| *p -= 1024.0);
    let mut expected: Vec<[i64; 3]> = mesh
        .positions
        .chunks_exact(3)
        .map(|p| std::array::from_fn(|a| ((mesh.origin[a] + p[a] as f64) * 1024.0 + 0.5).floor() as i64))
        .collect();
    expected.sort();
    expected.dedup();
    let mut c = MeshCollection::new();
    c.add(mesh);
    let b = c.encode_compact(32.0);
    assert_eq!(b.mesh_count(), 1, "refusals {:?}", b.refusals);
    let mut nodes: Vec<[i64; 3]> = b
        .records
        .chunks_exact(12)
        .map(|r| std::array::from_fn(|a| b.windows[a] as i64 + u16::from_le_bytes([r[a * 2], r[a * 2 + 1]]) as i64))
        .collect();
    nodes.sort();
    nodes.dedup();
    assert_eq!(nodes, expected);
}

/// A NaN or infinite normal would poison its node's sum and oct-encode to garbage: such a mesh
/// stays on the f32 path, untouched.
#[test]
fn a_non_finite_normal_refuses_the_mesh() {
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut c = MeshCollection::new();
        let mut mesh = flat_box(1, [0.0, 0.0, 0.0], 1.0);
        mesh.normals[40] = bad;
        c.add(mesh);
        let b = c.encode_compact(32.0);
        assert_eq!(b.mesh_count(), 0, "{bad}");
        assert_eq!(b.refusals[Refusal::NonFinite as usize], 1, "{bad}: {:?}", b.refusals);
        assert_eq!(c.meshes[0].positions.len(), 72);
    }
}
