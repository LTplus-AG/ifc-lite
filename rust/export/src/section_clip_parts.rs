// SPDX-License-Identifier: MPL-2.0
//! Restore source-item topology before palette partitions, then retain face colours.
use super::{mesh, MeshData, MeshFrame, SectionExportPlane, Tri};
use ifc_lite_geometry::{kernel::broadphase::Bvh, math::v3};
use std::collections::BTreeMap;

pub(super) struct CutPart {
    pub origin: [f64; 3],
    pub triangles: Vec<Tri>,
    pub color: [f32; 4],
    pub face_colors: Vec<[f32; 4]>,
}

pub(super) fn cut_parts(parts: &[&MeshData], frame: MeshFrame, planes: &[SectionExportPlane], trim: bool) -> Result<(Vec<CutPart>, bool), String> {
    // Palette/material boundaries do not own topology. Layer skins have no
    // item id: their owning occurrence supplies the collectively closed body.
    // A leaf id is not an occurrence id. Keep independent f64 origins separate:
    // rebasing a remote occurrence here would lose detail in the open f32 clipper.
    let mut owners = BTreeMap::new();
    for part in parts {
        if part.origin.iter().any(|v| !v.is_finite()) { return Err("non-finite section item origin".into()); }
        let key = (part.geometry_item_id, part.origin.map(|v| if v == 0.0 { 0 } else { v.to_bits() }));
        owners.entry(key).or_insert_with(Vec::new).push(*part);
    }
    let mut changed = false;
    let mut result = Vec::new();
    for parts in owners.values() {
        let origin = parts[0].origin;
        let mut source = Vec::new();
        let mut colors = Vec::new();
        for part in parts {
            for tri in mesh::triangles(part)? {
                source.push(tri);
                colors.push(part.color);
            }
        }
        if source.iter().flatten().flatten().any(|value| !value.is_finite()) { return Err("non-finite section item coordinates".into()); }
        if parts.len() > 1 { mesh::orient_outward(&mut source); }
        let color = parts[0].color;
        let varied = trim && colors.iter().any(|c| *c != color);
        let original = if varied { source.clone() } else { Vec::new() };
        let (triangles, cut) = super::cut_triangles(source, origin, frame, planes)?;
        changed |= cut;
        if triangles.is_empty() { continue; }
        let face_colors = if varied {
            if cut { project_colors(&original, &colors, &triangles, color)? } else { colors }
        } else { Vec::new() };
        result.push(CutPart { origin, triangles, color, face_colors });
    }
    Ok((result, changed))
}

fn project_colors(source: &[Tri], colors: &[[f32; 4]], output: &[Tri], cap: [f32; 4]) -> Result<Vec<[f32; 4]>, String> {
    // This BVH only attributes appearance; it never changes kernel topology.
    // Kept faces remain subdivisions of source triangles. New caps use the
    // source item's first colour, including its original opacity.
    let bvh = Bvh::build(source);
    let mut candidates = Vec::new();
    let mut work = 0usize;
    let mut result = Vec::with_capacity(output.len());
    for tri in output {
        let center = v3::scale(v3::add(v3::add(tri[0], tri[1]), tri[2]), 1. / 3.);
        candidates.clear();
        bvh.point_candidates(center, 1e-6, &mut candidates);
        work = work.saturating_add(candidates.len());
        if work > 2_000_000 { return Err("section face-colour attribution work limit exceeded".into()); }
        candidates.sort_unstable();
        let color = candidates.iter().find_map(|&id| {
            let t = source[id as usize];
            let n = v3::cross(v3::sub(t[1],t[0]), v3::sub(t[2],t[0]));
            let n2 = v3::dot(n,n);
            if n2 == 0. || v3::dot(n,v3::sub(center,t[0])).abs() > 1e-6*n2.sqrt() { return None; }
            let inside = (0..3).all(|i| v3::dot(n, v3::cross(v3::sub(t[(i+1)%3],t[i]),v3::sub(center,t[i]))) >= -1e-7*n2);
            inside.then_some(colors[id as usize])
        }).unwrap_or(cap);
        result.push(color);
    }
    Ok(result)
}
