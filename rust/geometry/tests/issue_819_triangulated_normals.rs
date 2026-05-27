// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #819 — IfcTriangulatedFaceSet must flat-shade
//! when the file provides no per-vertex Normals (attr 1 = `$`).
//!
//! `IFC4TessellationComplex.ifc` is a Revit IFC4 export of a faceted dome
//! light fixture. The author wrote each fixture as
//! `IFCTRIANGULATEDFACESET(coords, $, $, …)` — no per-vertex normals, no
//! closure flag.
//!
//! Before the fix the processor emitted the original (shared-vertex)
//! position/index buffer and let `csg::calculate_normals` smooth-average
//! face normals at every shared vertex. On a hard-faceted dome this
//! smears each panel's sharp edge into a gradient — the visible "normals
//! are wrong" complaint when contrasted with BIMVision's flat-shaded
//! render.
//!
//! After the fix `TriangulatedFaceSetProcessor` duplicates vertices
//! per-triangle and writes one face normal per triangle, the same path
//! `PolygonalFaceSetProcessor` already uses. The downstream WASM
//! `calculate_normals` either preserves these (desktop path is a no-op)
//! or re-computes them — and because every vertex now belongs to exactly
//! one triangle, the re-computation collapses to per-face normals too.
//!
//! Fixture: `tests/models/issues/819_IFC4TessellationComplex.ifc`.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/819_IFC4TessellationComplex.ifc";

// Five largest IFCTRIANGULATEDFACESET entities in the file. All five
// declare Normals = $, Closed = $ — i.e. the codepath that was producing
// smooth-averaged normals before the fix.
const FACESETS: &[u32] = &[1480, 4373, 5127, 5657, 5795];

/// See `issue_820_trimmed_curve_planeangleunit::lfs_pointer_prefix` for
/// why this string is built at runtime instead of being a string literal.
fn lfs_pointer_prefix() -> String {
    format!("version {}{}", "https://git-lfs.github.com/", "spec/")
}

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) if s.starts_with(&lfs_pointer_prefix()) => {
            eprintln!(
                "skipping issue-819 regression: fixture at {FIXTURE} is a Git LFS \
                 pointer — run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-819 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` from the repo root to download it",
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

#[test]
fn triangulated_face_sets_emit_flat_shaded_per_triangle_normals() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    for &id in FACESETS {
        let entity = decoder
            .decode_by_id(id)
            .unwrap_or_else(|e| panic!("decode #{} ({})", id, e));
        assert_eq!(
            entity.ifc_type,
            IfcType::IfcTriangulatedFaceSet,
            "expected IfcTriangulatedFaceSet at #{}",
            id,
        );

        let mesh = router
            .process_representation_item(&entity, &mut decoder)
            .unwrap_or_else(|e| panic!("tessellate #{}: {}", id, e));

        assert!(
            !mesh.positions.is_empty() && !mesh.indices.is_empty(),
            "#{} produced empty mesh",
            id,
        );
        assert_eq!(mesh.indices.len() % 3, 0, "#{} indices not in triples", id);

        let tri_count = mesh.indices.len() / 3;
        let vertex_count = mesh.positions.len() / 3;

        // Flat-shading invariant 1: every triangle has its own three
        // vertices. Pre-fix, shared vertices made `vertex_count` strictly
        // less than `tri_count * 3` — typically by 50-80% on closed shells.
        assert_eq!(
            vertex_count,
            tri_count * 3,
            "#{} has {} verts for {} tris — flat-shading vertex duplication did not run",
            id,
            vertex_count,
            tri_count,
        );

        // Flat-shading invariant 2: per-vertex normals exist (one set per
        // duplicated vertex) and the three normals of every triangle are
        // identical (= the triangle's face normal). Pre-fix, downstream
        // smooth-averaging produced different normals per shared vertex.
        assert_eq!(
            mesh.normals.len(),
            mesh.positions.len(),
            "#{} normals length {} != positions length {}",
            id,
            mesh.normals.len(),
            mesh.positions.len(),
        );

        for (tri_idx, tri) in mesh.indices.chunks_exact(3).enumerate() {
            let n0 = [
                mesh.normals[tri[0] as usize * 3],
                mesh.normals[tri[0] as usize * 3 + 1],
                mesh.normals[tri[0] as usize * 3 + 2],
            ];
            let n1 = [
                mesh.normals[tri[1] as usize * 3],
                mesh.normals[tri[1] as usize * 3 + 1],
                mesh.normals[tri[1] as usize * 3 + 2],
            ];
            let n2 = [
                mesh.normals[tri[2] as usize * 3],
                mesh.normals[tri[2] as usize * 3 + 1],
                mesh.normals[tri[2] as usize * 3 + 2],
            ];
            for axis in 0..3 {
                let d01 = (n0[axis] - n1[axis]).abs();
                let d12 = (n1[axis] - n2[axis]).abs();
                assert!(
                    d01 < 1e-5 && d12 < 1e-5,
                    "#{}, triangle {}: axis-{} normals diverge \
                     ({}, {}, {}) — flat-shading collapsed back to smooth",
                    id,
                    tri_idx,
                    axis,
                    n0[axis],
                    n1[axis],
                    n2[axis],
                );
            }
        }
    }
}
