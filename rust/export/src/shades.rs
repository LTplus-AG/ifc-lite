// SPDX-License-Identifier: MPL-2.0
//! Shades (railings → ShadeMesh) for the HBJSON exporter — wasm-safe, profile-based.
//!
//! `IfcRailing` posts/rails come through `extract_profiles` as small extruded prisms (the
//! native mesher traps in wasm, so we reuse the same profile source as rooms/openings).
//! Each prism's side surface is triangulated and all of a railing's prisms are combined into
//! one `ShadeMesh`. Shading geometry needs no watertightness — a triangle soup is correct here.

use std::collections::HashMap;

use ifc_lite_geometry::ExtractedProfile;

use crate::hbjson::ShadeMesh;
use crate::rooms::{clean_ring, xf, zup};

/// Build one `ShadeMesh` per `IfcRailing` occurrence from its extruded profile prisms.
pub fn build_shades(profiles: &[ExtractedProfile], origin: [f64; 3]) -> Vec<ShadeMesh> {
    let mut by: HashMap<u32, Vec<&ExtractedProfile>> = HashMap::new();
    for p in profiles {
        if p.ifc_type == "IfcRailing" {
            by.entry(p.express_id).or_default().push(p);
        }
    }

    let mut shades = Vec::new();
    for (id, ps) in &by {
        let mut verts: Vec<[f64; 3]> = Vec::new();
        let mut faces: Vec<[usize; 3]> = Vec::new();
        for p in ps {
            let n = p.outer_points.len() / 2;
            if n < 3 {
                continue;
            }
            let dir = zup([p.extrusion_dir[0] as f64, p.extrusion_dir[1] as f64, p.extrusion_dir[2] as f64]);
            let depth = p.extrusion_depth as f64;
            let ring: Vec<[f64; 3]> = (0..n)
                .map(|i| {
                    let w = xf(&p.transform, p.outer_points[i * 2] as f64, p.outer_points[i * 2 + 1] as f64);
                    [w[0] - origin[0], w[1] - origin[1], w[2] - origin[2]]
                })
                .collect();
            let ring = clean_ring(ring, 1.0e-4);
            let m = ring.len();
            if m < 3 {
                continue;
            }
            // base ring, then top ring (extruded).
            let base = verts.len();
            for r in &ring {
                verts.push(*r);
            }
            for r in &ring {
                verts.push([r[0] + dir[0] * depth, r[1] + dir[1] * depth, r[2] + dir[2] * depth]);
            }
            // side quads → two triangles each (the visible shade surface).
            for i in 0..m {
                let j = (i + 1) % m;
                let (bi, bj, ti, tj) = (base + i, base + j, base + m + i, base + m + j);
                faces.push([bi, bj, tj]);
                faces.push([bi, tj, ti]);
            }
        }
        if !faces.is_empty() {
            shades.push(ShadeMesh::new(format!("Rail{}", id), verts, faces));
        }
    }
    shades
}
