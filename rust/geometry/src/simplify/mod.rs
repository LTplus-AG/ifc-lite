// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-element mesh simplification ("demesher").
//!
//! Reduces an element mesh's triangle count for lightweight re-export:
//! enclosed-cavity removal (drops shells fully contained inside the outer
//! shell — bolt holes, internal machining detail), grid vertex-clustering
//! decimation (Rust port of the renderer's LOD1 `simplifyIndicesByClustering`,
//! which is proven on this pipeline's unwelded flat-shaded facet soup), and
//! bounding-box collapse. All passes key on vertex POSITION, never on index
//! topology, because the pipeline deliberately emits per-face duplicated
//! vertices (issue #846).

mod boxify;
mod cavities;
mod cluster;
mod ray_parity;

use crate::mesh::Mesh;

/// Simplification tuning for one element mesh.
#[derive(Debug, Clone)]
pub struct SimplifyOptions {
    /// Target triangle ratio for clustering decimation (e.g. 0.5 halves the
    /// count). `None` skips the clustering pass.
    pub target_ratio: Option<f32>,
    /// Drop connected components fully enclosed inside the outer shell.
    pub drop_cavities: bool,
    /// Replace the mesh with a 12-triangle axis-aligned bounding box
    /// (positions-frame AABB). Overrides the other passes.
    pub boxify: bool,
    /// Meshes below this triangle count pass through untouched (except
    /// `boxify`, which always applies).
    pub min_triangles: u32,
    /// Position-weld bucket size in metres for cavity connectivity.
    pub weld_eps: f32,
}

impl SimplifyOptions {
    /// Preset for the demesher's escalation levels 1..=5 (each button press
    /// escalates one level): 1-4 = cavity removal + clustering at a shrinking
    /// triangle ratio, 5 = bounding-box collapse. Levels above 5 clamp to 5.
    pub fn for_level(level: u8) -> Self {
        let target_ratio = match level {
            0 | 1 => Some(0.5),
            2 => Some(0.25),
            3 => Some(0.10),
            4 => Some(0.03),
            _ => None,
        };
        Self {
            target_ratio,
            drop_cavities: level < 5,
            boxify: level >= 5,
            min_triangles: 32,
            weld_eps: 1e-6,
        }
    }
}

/// What `simplify_mesh` did to one element mesh.
#[derive(Debug, Clone, Default)]
pub struct SimplifyStats {
    pub tris_before: u32,
    pub tris_after: u32,
    pub cavity_components_dropped: u32,
    pub cavity_triangles_dropped: u32,
    /// Clustering cell-size growth iterations taken to reach the target ratio
    /// (0 when the pass was skipped or the input was already at target).
    pub cell_iterations: u32,
    /// True when the mesh was returned untouched (below `min_triangles`, or
    /// empty).
    pub passthrough: bool,
}

/// Simplify one element mesh. Returns a new mesh carrying the input's
/// placement/frame metadata (`origin`, `rtc_applied`, `local_bounds`,
/// `local_to_world`) so world reconstruction (`world = origin + position
/// (+ rtc)`) and the inverse-placement export path keep working.
///
/// A clustered result comes back with an EMPTY normal buffer (the pass
/// changes topology, so the input's per-face normals no longer apply);
/// consumers rebuild normals when `normals.len() != positions.len()`.
pub fn simplify_mesh(mesh: &Mesh, opts: &SimplifyOptions) -> (Mesh, SimplifyStats) {
    let mut stats = SimplifyStats {
        tris_before: (mesh.indices.len() / 3) as u32,
        ..Default::default()
    };

    if opts.boxify {
        let out = boxify::box_from_positions_aabb(mesh);
        stats.tris_after = (out.indices.len() / 3) as u32;
        return (out, stats);
    }

    if mesh.is_empty() || stats.tris_before < opts.min_triangles {
        stats.tris_after = stats.tris_before;
        stats.passthrough = true;
        return (mesh.clone(), stats);
    }

    let mut out = mesh.clone();

    if opts.drop_cavities {
        let cavity = cavities::drop_enclosed_cavities(&mut out, opts.weld_eps);
        stats.cavity_components_dropped = cavity.components_dropped;
        stats.cavity_triangles_dropped = cavity.triangles_dropped;
    }

    if let Some(ratio) = opts.target_ratio {
        let (clustered, iterations) = cluster::cluster_to_ratio(&out, ratio, opts.min_triangles);
        out = clustered;
        stats.cell_iterations = iterations;
    }

    out.drop_degenerate_triangles();
    out.clean_degenerate();

    stats.tris_after = (out.indices.len() / 3) as u32;
    (out, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Axis-aligned box as unwelded facet soup (24 verts, 12 tris), the shape
    /// the production pipeline emits (issue #846).
    fn soup_box(min: [f32; 3], max: [f32; 3]) -> Mesh {
        let mesh = Mesh::new();
        let mut boxed = boxify::box_from_corners(&mesh, min, max);
        // box_from_corners carries frame metadata from `mesh` (defaults here).
        boxed.local_bounds = Some([min[0], min[1], min[2], max[0], max[1], max[2]]);
        boxed
    }

    fn merged(a: &Mesh, b: &Mesh) -> Mesh {
        let mut m = a.clone();
        m.merge(b);
        m
    }

    /// Dense tessellated sphere as facet soup (per-triangle vertices).
    fn soup_sphere(center: [f32; 3], radius: f32, rings: u32, segs: u32) -> Mesh {
        let mut mesh = Mesh::new();
        let pt = |r: u32, s: u32| -> [f32; 3] {
            let theta = std::f32::consts::PI * (r as f32) / (rings as f32);
            let phi = 2.0 * std::f32::consts::PI * (s as f32) / (segs as f32);
            [
                center[0] + radius * theta.sin() * phi.cos(),
                center[1] + radius * theta.sin() * phi.sin(),
                center[2] + radius * theta.cos(),
            ]
        };
        let mut push_tri = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| {
            let base = (mesh.positions.len() / 3) as u32;
            for v in [a, b, c] {
                mesh.positions.extend_from_slice(&v);
                mesh.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
        };
        for r in 0..rings {
            for s in 0..segs {
                let (a, b, c, d) = (pt(r, s), pt(r + 1, s), pt(r + 1, s + 1), pt(r, s + 1));
                push_tri(a, b, c);
                push_tri(a, c, d);
            }
        }
        mesh
    }

    #[test]
    fn cavity_inside_box_is_dropped_and_outer_kept_bit_identical() {
        let outer = soup_box([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
        let inner = soup_box([4.0, 4.0, 4.0], [6.0, 6.0, 6.0]);
        let combined = merged(&outer, &inner);

        let opts = SimplifyOptions {
            target_ratio: None,
            drop_cavities: true,
            boxify: false,
            min_triangles: 1,
            weld_eps: 1e-6,
        };
        let (out, stats) = simplify_mesh(&combined, &opts);

        assert_eq!(stats.cavity_components_dropped, 1);
        assert_eq!(out.indices.len() / 3, 12, "only the outer box survives");
        // Index-subset contract: surviving triangles reference the ORIGINAL
        // vertex buffer untouched.
        assert_eq!(out.positions, combined.positions);
    }

    #[test]
    fn component_outside_is_kept() {
        let a = soup_box([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
        let b = soup_box([20.0, 0.0, 0.0], [30.0, 10.0, 10.0]);
        let combined = merged(&a, &b);

        let opts = SimplifyOptions {
            target_ratio: None,
            drop_cavities: true,
            boxify: false,
            min_triangles: 1,
            weld_eps: 1e-6,
        };
        let (out, stats) = simplify_mesh(&combined, &opts);
        assert_eq!(stats.cavity_components_dropped, 0);
        assert_eq!(out.indices.len() / 3, 24);
    }

    #[test]
    fn non_watertight_outer_disables_cavity_removal() {
        let mut outer = soup_box([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
        // Rip the top face off (last 4 triangles of the box layout are the
        // left/right faces; drop the two "top" triangles at positions 2,3).
        outer.indices.drain(6..12);
        let inner = soup_box([4.0, 4.0, 4.0], [6.0, 6.0, 6.0]);
        let combined = merged(&outer, &inner);

        let opts = SimplifyOptions {
            target_ratio: None,
            drop_cavities: true,
            boxify: false,
            min_triangles: 1,
            weld_eps: 1e-6,
        };
        let (_, stats) = simplify_mesh(&combined, &opts);
        assert_eq!(
            stats.cavity_components_dropped, 0,
            "open outer shell must disable cavity removal (conservative-keep)"
        );
    }

    /// Closed L-shaped prism (non-convex): footprint = [0,10]x[0,4] plus
    /// [6,10]x[4,10], extruded z 0..10, as quad soup with exactly matching
    /// corner coordinates (welds into one watertight component, no
    /// T-junctions). The notch [0,6)x(4,10] is inside the outer AABB but
    /// OUTSIDE the solid.
    fn soup_l_prism() -> Mesh {
        let mut mesh = Mesh::new();
        let mut quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| {
            let base = (mesh.positions.len() / 3) as u32;
            for v in [a, b, c, d] {
                mesh.positions.extend_from_slice(&v);
                mesh.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            mesh.indices
                .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        };
        // Caps: three rects per z, split so shared edges match exactly.
        let rects: [[f32; 4]; 3] = [
            [0.0, 0.0, 6.0, 4.0],
            [6.0, 0.0, 10.0, 4.0],
            [6.0, 4.0, 10.0, 10.0],
        ];
        for z in [0.0f32, 10.0f32] {
            for [x0, y0, x1, y1] in rects {
                quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]);
            }
        }
        // Walls along the boundary polygon, split at cap-rect corners.
        let ring: [[f32; 2]; 9] = [
            [0.0, 0.0],
            [6.0, 0.0],
            [10.0, 0.0],
            [10.0, 4.0],
            [10.0, 10.0],
            [6.0, 10.0],
            [6.0, 4.0],
            [0.0, 4.0],
            [0.0, 0.0],
        ];
        for w in ring.windows(2) {
            let ([ax, ay], [bx, by]) = (w[0], w[1]);
            quad([ax, ay, 0.0], [bx, by, 0.0], [bx, by, 10.0], [ax, ay, 10.0]);
        }
        mesh
    }

    #[test]
    fn partially_protruding_component_is_kept_in_nonconvex_outer() {
        // Candidate whose AABB centre (3, 2.75, 5) is INSIDE the L's solid
        // arm but whose +y end reaches into the notch void — the centre-only
        // classification would drop it and punch away visible geometry.
        let outer = soup_l_prism();
        let outer_tris = outer.indices.len() / 3;
        let protruding = soup_box([2.0, 0.5, 4.0], [4.0, 5.0, 6.0]);
        let combined = merged(&outer, &protruding);

        let opts = SimplifyOptions {
            target_ratio: None,
            drop_cavities: true,
            boxify: false,
            min_triangles: 1,
            weld_eps: 1e-6,
        };
        let (out, stats) = simplify_mesh(&combined, &opts);
        assert_eq!(
            stats.cavity_components_dropped, 0,
            "a component protruding out of the outer solid must never be dropped"
        );
        assert_eq!(out.indices.len() / 3, outer_tris + 12);
    }

    #[test]
    fn fully_enclosed_component_in_nonconvex_outer_is_dropped() {
        let outer = soup_l_prism();
        let outer_tris = outer.indices.len() / 3;
        let cavity = soup_box([1.0, 1.0, 4.0], [2.0, 2.0, 5.0]);
        let combined = merged(&outer, &cavity);

        let opts = SimplifyOptions {
            target_ratio: None,
            drop_cavities: true,
            boxify: false,
            min_triangles: 1,
            weld_eps: 1e-6,
        };
        let (out, stats) = simplify_mesh(&combined, &opts);
        assert_eq!(stats.cavity_components_dropped, 1);
        assert_eq!(out.indices.len() / 3, outer_tris);
    }

    #[test]
    fn clustering_reaches_target_ratio_on_dense_sphere() {
        let sphere = soup_sphere([0.0, 0.0, 0.0], 1.0, 48, 48);
        let before = sphere.indices.len() / 3;
        assert!(before > 4000);

        let opts = SimplifyOptions {
            target_ratio: Some(0.25),
            drop_cavities: false,
            boxify: false,
            min_triangles: 32,
            weld_eps: 1e-6,
        };
        let (out, stats) = simplify_mesh(&sphere, &opts);
        let after = out.indices.len() / 3;
        assert!(after > 0, "clustering must not empty the mesh");
        assert!(
            after as f32 <= before as f32 * 0.25,
            "expected <= 25% of {before} triangles, got {after}"
        );
        assert!(stats.cell_iterations >= 1);
    }

    #[test]
    fn small_mesh_passes_through() {
        let small = soup_box([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
        let (out, stats) = simplify_mesh(&small, &SimplifyOptions::for_level(1));
        assert!(stats.passthrough);
        assert_eq!(out.positions, small.positions);
        assert_eq!(out.indices, small.indices);
    }

    #[test]
    fn boxify_emits_12_triangles_matching_positions_aabb() {
        let sphere = soup_sphere([5.0, -3.0, 2.0], 2.0, 16, 16);
        let (smin, smax) = sphere.bounds();
        let (out, stats) = simplify_mesh(&sphere, &SimplifyOptions::for_level(5));
        assert_eq!(out.indices.len() / 3, 12);
        assert_eq!(stats.tris_after, 12);
        let (bmin, bmax) = out.bounds();
        assert_eq!((bmin, bmax), (smin, smax));
    }

    #[test]
    fn frame_metadata_is_carried() {
        let mut sphere = soup_sphere([0.0, 0.0, 0.0], 1.0, 32, 32);
        sphere.origin = [100.0, 200.0, 300.0];
        sphere.rtc_applied = true;
        sphere.local_bounds = Some([-1.0, -1.0, -1.0, 1.0, 1.0, 1.0]);
        sphere.local_to_world = Some([
            1.0, 0.0, 0.0, 7.0, 0.0, 1.0, 0.0, 8.0, 0.0, 0.0, 1.0, 9.0, 0.0, 0.0, 0.0, 1.0,
        ]);

        for level in [1u8, 5u8] {
            let (out, _) = simplify_mesh(&sphere, &SimplifyOptions::for_level(level));
            assert_eq!(out.origin, sphere.origin, "level {level}");
            assert!(out.rtc_applied, "level {level}");
            assert_eq!(out.local_bounds, sphere.local_bounds, "level {level}");
            assert_eq!(out.local_to_world, sphere.local_to_world, "level {level}");
        }
    }
}
