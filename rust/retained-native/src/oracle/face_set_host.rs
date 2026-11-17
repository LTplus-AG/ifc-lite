// SPDX-License-Identifier: MPL-2.0
//! Voided hosts whose Body authors face sets (#7955): their source cut expectation, from the
//! authored rows alone. A closed set is a signed fan of tetrahedra about one point; clipping
//! each by convex planes and summing integrates exactly, with no mesh and no kernel.
use super::{face_sets, math::*, openings::OpeningExpectation, section_net::{self, ConvexCut, Halfspace}, sections::ExtrudedHost};
use ifc_lite_core::{DecodedEntity, IfcType, SourceBundle};
use ifc_lite_geometry::{placement::resolve_object_placement, representation::{product_shape, rep_items, Select}, Matrix4, Point3};
use ifc_lite_processing::AnalyticQuantitySources;
use std::sync::Arc;

type Tet = [[f64; 3]; 4];
/// How far an authored row may leave its own plane and still count as a face of a convex
/// cutter (rvt01 #12412: 0.16 µm). Over a thin opening that moves far less than any volume limit.
const WARP_METRES: f64 = 1e-6;
/// Tetrahedra of a closed set, sign carried by winding.
struct ClosedSet { tets: Vec<Tet>, faces: Vec<ConvexFace> }
struct ConvexFace { origin: [f64; 3], normal: [f64; 3], holed: bool }

fn signed(t: &Tet) -> f64 { dot(sub(t[1], t[0]), cross(sub(t[2], t[0]), sub(t[3], t[0]))) / 6. }
fn lerp(a: [f64; 3], b: [f64; 3], s: f64) -> [f64; 3] { std::array::from_fn(|i| a[i] + s * (b[i] - a[i])) }
/// The part of a tetrahedron with n·x <= c, as tetrahedra of the same orientation.
fn clip(t: &Tet, (n, c): &Halfspace, out: &mut Vec<Tet>) {
    let d = t.map(|p| dot(*n, p) - c);
    let mut inside = Vec::new();
    let mut outside = Vec::new();
    for (i, distance) in d.iter().enumerate() { if *distance <= 0. { inside.push(i); } else { outside.push(i); } }
    let at = |a: usize, b: usize| lerp(t[a], t[b], d[a] / (d[a] - d[b]));
    // Keep the source vertex order by replacing vertices in place, so signs survive.
    match (inside.len(), outside.len()) {
        (4, _) => out.push(*t),
        (0, _) => {}
        (1, _) => {
            let k = inside[0];
            let mut r = *t;
            for &o in &outside { r[o] = at(k, o); }
            out.push(r);
        }
        (3, _) => {
            // Remove the corner at `o`: three tetrahedra fill the rest.
            let o = outside[0];
            let [a, b, c] = [inside[0], inside[1], inside[2]];
            let (pa, pb, pc) = (at(a, o), at(b, o), at(c, o));
            let mut first = *t; first[o] = pa;
            let mut second = *t; second[o] = pb; second[a] = pa;
            let mut third = *t; third[o] = pc; third[a] = pa; third[b] = pb;
            out.extend([first, second, third]);
        }
        _ => {
            // Two in, two out: a wedge, three tetrahedra.
            let ([a, b], [p, q]) = ([inside[0], inside[1]], [outside[0], outside[1]]);
            let (ap, aq, bp, bq) = (at(a, p), at(a, q), at(b, p), at(b, q));
            let mut first = *t; first[p] = ap; first[q] = aq;
            let mut second = *t; second[a] = ap; second[p] = bp; second[q] = aq;
            let mut third = *t; third[a] = aq; third[p] = bp; third[q] = bq;
            out.extend([first, second, third]);
        }
    }
}
impl ClosedSet {
    fn volume_in(&self, planes: &[Halfspace]) -> Option<f64> {
        let mut sum = 0.;
        let mut work = 20_000_000usize;
        let (mut now, mut next) = (Vec::new(), Vec::new());
        for tet in &self.tets {
            now.clear();
            now.push(*tet);
            for plane in planes {
                next.clear();
                for t in &now { work = work.checked_sub(1)?; clip(t, plane, &mut next); }
                std::mem::swap(&mut now, &mut next);
                if now.is_empty() { break; }
            }
            sum += now.iter().map(signed).sum::<f64>();
        }
        // Outward winding is the authored one's, either way round: only a magnitude is a volume.
        sum.is_finite().then_some(sum)
    }
}
fn world_of(element: &DecodedEntity, decoder: &mut ifc_lite_core::EntityDecoder, scale: f64) -> Option<Matrix4<f64>> {
    let mut world = resolve_object_placement(element, decoder).ok()?.unwrap_or_else(Matrix4::identity);
    for i in 0..3 { for j in 0..4 { world[(i, j)] *= scale; } }
    Some(world)
}
/// A ring's area vector (Newell), from offsets to its first corner: absolute georeferenced
/// coordinates would round each cross term at their own magnitude, not the ring's.
fn newell(ring: &[[f64; 3]]) -> [f64; 3] {
    let Some(&origin) = ring.first() else { return [0.; 3] };
    ring.iter().enumerate().fold([0.; 3], |n, (i, p)| {
        let c = cross(sub(*p, origin), sub(ring[(i + 1) % ring.len()], origin));
        [n[0] + c[0], n[1] + c[1], n[2] + c[2]]
    })
}
/// A closed set in world metres, from its rows only. A hole is a ring wound against the outer
/// one: its fan subtracts, so a row with voids needs no triangulation.
fn closed_set(item: &DecodedEntity, decoder: &mut ifc_lite_core::EntityDecoder, world: &Matrix4<f64>, scale: f64) -> Result<ClosedSet, &'static str> {
    let set = face_sets::authored(item, decoder, scale).ok_or("face_set_unreadable")?;
    if set.open_edges != 0 { return Err("open_face_set"); }
    let at = |p: &[f64; 3]| { let q = world.transform_point(&Point3::new(p[0] / scale + set.first[0], p[1] / scale + set.first[1], p[2] / scale + set.first[2])); [q.x, q.y, q.z] };
    let apex = at(set.rows.first().and_then(|r| r.points.first()).ok_or("face_set_unreadable")?);
    let (mut tets, mut faces) = (Vec::new(), Vec::new());
    // Each authored edge, directed as its oriented ring runs: a consistent shell runs every
    // edge once each way. Undirected closure alone admits a row wound against the rest.
    let mut directed: std::collections::BTreeMap<([u64; 3], [u64; 3]), usize> = std::collections::BTreeMap::new();
    let bits = |p: &[f64; 3]| p.map(|v| (v + 0.).to_bits());
    // The row each tetrahedron fans, and the rows each undirected edge joins: one shell each.
    let (mut tet_rows, mut edge_rows) = (Vec::new(), std::collections::BTreeMap::new());
    let mut shell: Vec<usize> = (0..set.rows.len()).collect();
    fn root(shell: &mut [usize], mut i: usize) -> usize { while shell[i] != i { shell[i] = shell[shell[i]]; i = shell[i]; } i }
    for (k, (row, ends)) in set.rows.iter().zip(&set.row_rings).enumerate() {
        // `authored` stores a row it could not read (an index past the points, under three
        // corners) empty: what the source says there is unknown, so the shell is too.
        if row.points.is_empty() { return Err("face_set_row_unreadable"); }
        let points: Vec<[f64; 3]> = row.points.iter().map(&at).collect();
        let Some(&outer_end) = ends.first() else { continue };
        let outer_normal = newell(&points[..outer_end]);
        // A warped row has no single surface: another fan diagonal bounds another volume. Past
        // the warp a published f64 position can carry, the source has no answer here.
        if row.area_m2.is_none() {
            let normal = unit(outer_normal).ok_or("warped_face_set_row")?;
            if points.iter().any(|p| dot(normal, sub(*p, points[0])).abs() > WARP_METRES) { return Err("warped_face_set_row"); }
        }
        let mut start = 0;
        for &end in ends {
            let mut ring = points[start..end].to_vec();
            let mut raw: Vec<[u64; 3]> = row.points[start..end].iter().map(bits).collect();
            if start > 0 && dot(newell(&ring), outer_normal) > 0. { ring.reverse(); raw.reverse(); }
            for (i, a) in raw.iter().enumerate() {
                let b = raw[(i + 1) % raw.len()];
                if *a != b {
                    *directed.entry((*a, b)).or_default() += 1;
                    let other = *edge_rows.entry((*a.min(&b), *a.max(&b))).or_insert(k);
                    let (x, y) = (root(&mut shell, other), root(&mut shell, k));
                    shell[x] = y;
                }
            }
            for i in 1..ring.len().saturating_sub(1) { tets.push([apex, ring[0], ring[i], ring[i + 1]]); tet_rows.push(k); }
            start = end;
        }
        if row.area_m2 == Some(0.) { continue; }
        if let (Some(normal), Some(origin)) = (unit(outer_normal), points.first()) { faces.push(ConvexFace { origin: *origin, normal, holed: ends.len() > 1 }); }
    }
    if directed.iter().any(|(&(a, b), &n)| n != 1 || directed.get(&(b, a)) != Some(&1)) { return Err("face_set_winding_inconsistent"); }
    // Each shell is consistent, but shells wound against each other are either disjoint solids
    // (which add) or a cavity inside its host (which subtracts): the rows cannot tell which.
    let mut volume: std::collections::BTreeMap<usize, f64> = std::collections::BTreeMap::new();
    for (tet, &k) in tets.iter().zip(&tet_rows) { *volume.entry(root(&mut shell, k)).or_default() += signed(tet); }
    if volume.values().any(|v| *v > 0.) && volume.values().any(|v| *v < 0.) { return Err("face_set_shells_opposed"); }
    Ok(ClosedSet { tets, faces })
}
/// A closed set as one convex cutter, with its volume; a non-convex one has none here.
fn convex_cut(set: &ClosedSet) -> Option<(ConvexCut, f64)> {
    if set.faces.iter().any(|face| face.holed) { return None; }
    let points: Vec<[f64; 3]> = set.tets.iter().flat_map(|t| t[1..].iter().copied()).collect();
    let mut cut = Vec::with_capacity(set.faces.len());
    for face in &set.faces {
        let side = |p: &[f64; 3]| dot(face.normal, sub(*p, face.origin));
        let (low, high) = points.iter().fold((0f64, 0f64), |(l, h), p| (l.min(side(p)), h.max(side(p))));
        if low < -WARP_METRES && high > WARP_METRES { return None; }
        let outward = if high > WARP_METRES { face.normal.map(|v| -v) } else { face.normal };
        cut.push((outward, dot(outward, face.origin)));
    }
    let volume = set.volume_in(&[])?.abs();
    Some((cut, volume))
}
enum Solid { Extrusion(Box<ExtrudedHost>), FaceSet(ClosedSet) }

/// Whether this product's Body authors a face set directly: nominal extrusion quantities then
/// describe only some of its solid, and only this oracle may set its cut expectation.
pub fn authors_face_set(bundle: &Arc<SourceBundle>, product: u32) -> bool {
    let mut decoder = bundle.decoder();
    let Ok(element) = decoder.decode_by_id(product) else { return false };
    let Ok(Some(shape)) = product_shape(&element, &mut decoder) else { return false };
    let authored = shape.select(&element, Select::Meshed).any(|rep| rep_items(rep, &mut decoder).is_ok_and(|items| items.iter().any(|i| is_face_set(&i.ifc_type))));
    authored
}
fn is_face_set(kind: &IfcType) -> bool { matches!(kind, IfcType::IfcPolygonalFaceSet | IfcType::IfcTriangulatedFaceSet) }
/// A product's Body items as integrable solids: its direct extrusions and closed face sets.
fn solids(bundle: &Arc<SourceBundle>, sources: &AnalyticQuantitySources, product: u32) -> Result<Vec<Solid>, &'static str> {
    let mut decoder = bundle.decoder();
    let element = decoder.decode_by_id(product).map_err(|_| "body_unreadable")?;
    let shape = product_shape(&element, &mut decoder).ok().flatten().ok_or("body_unreadable")?;
    let scale = sources.extrusion_definitions.length_unit_scale;
    let world = world_of(&element, &mut decoder, scale).ok_or("body_unreadable")?;
    let instances = sources.extrusion_definitions.instances.get(&product).map_or(&[][..], Vec::as_slice);
    let mut out = Vec::new();
    for rep in shape.select(&element, Select::Meshed) {
        for item in rep_items(rep, &mut decoder).map_err(|_| "body_unreadable")? {
            if is_face_set(&item.ifc_type) {
                out.push(Solid::FaceSet(closed_set(&item, &mut decoder, &world, scale)?));
            } else {
                let instance = instances.iter().find(|i| i.solid_id == item.id && !i.source_modified).ok_or("body_item_not_extrusion_or_face_set")?;
                out.push(Solid::Extrusion(Box::new(ExtrudedHost::from_sources(sources, instance).ok_or("extrusion_source_incomplete")?)));
            }
        }
    }
    if out.is_empty() { return Err("empty_body"); }
    Ok(out)
}
/// The opened volume of a Body of closed face sets and extrusions, cutters of the same kinds.
/// An `Err` is a gap the caller counts by name, never a volume of what could be read.
pub fn expected(bundle: &Arc<SourceBundle>, sources: &AnalyticQuantitySources, host: u32, cutters: &[u32]) -> Result<OpeningExpectation, &'static str> {
    let (mut cuts, mut cutter_volume, mut arcs) = (Vec::new(), 0., false);
    for &id in cutters {
        for solid in solids(bundle, sources, id).map_err(|reason| match reason {
            "open_face_set" => "open_face_set_cutter",
            "body_item_not_extrusion_or_face_set" => "cutter_not_extrusion_or_face_set",
            other => other,
        })? {
            match solid {
                Solid::Extrusion(cutter) => {
                    let (pieces, curved) = section_net::extrusion_cutters(&cutter).ok_or("cutter_profile_not_single_loop")?;
                    cutter_volume += super::sections::section_volume(&cutter, &[]).ok_or("integral")?;
                    arcs |= curved;
                    cuts.push(pieces);
                }
                Solid::FaceSet(set) => {
                    let (cut, volume) = convex_cut(&set).ok_or("non_convex_face_set_cutter")?;
                    cutter_volume += volume;
                    cuts.push(vec![cut]);
                }
            }
        }
    }
    let (mut host_volume, mut result, mut host_arcs, mut only_extrusions) = (0., 0., false, true);
    for solid in solids(bundle, sources, host)? {
        only_extrusions &= matches!(solid, Solid::Extrusion(_));
        match solid {
            Solid::Extrusion(part) => {
                host_arcs |= part.has_arcs();
                host_volume += super::sections::section_volume(&part, &[]).ok_or("integral")?;
                result += section_net::net_volume(&part, &[], &cuts).ok_or("integral")?;
            }
            Solid::FaceSet(set) => {
                let whole = set.volume_in(&[]).ok_or("integral")?;
                let sign = whole.signum();
                host_volume += whole.abs();
                let oriented = |planes: &[Halfspace]| set.volume_in(planes).map(|v| v * sign);
                result += section_net::net_of(&oriented, &[], &cuts).ok_or("integral")?;
            }
        }
    }
    Ok(OpeningExpectation { nominal_host_volume: host_volume, volume_bounds: [(host_volume - cutter_volume).max(0.), host_volume],
        // A Body of extrusions alone keeps its nominal bounds: the result must stay inside them.
        result_volume: Some(result), curved: arcs || host_arcs,
        host_bbox: only_extrusions.then(|| super::openings::nominal(sources, host).and_then(|(_, bbox)| bbox)).flatten() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tilted triangle has one normal wherever it is placed, georeferenced coordinates included.
    #[test]
    fn a_row_normal_does_not_depend_on_its_placement() {
        let ring = [[0., 0., 0.], [1.3, 0.2, 0.7], [0.1, 0.9, 0.4]];
        let far = ring.map(|p| [p[0] + 2_612_345.678, p[1] + 1_234_567.891, p[2] + 431.27]);
        let (near, moved) = (unit(newell(&ring)).unwrap(), unit(newell(&far)).unwrap());
        let angle = cross(near, moved).iter().map(|v| v * v).sum::<f64>().sqrt();
        assert!(angle < 1e-9, "the normal turned {angle} rad");
    }
}
