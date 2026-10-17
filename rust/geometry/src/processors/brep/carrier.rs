// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Transactional adjacent-carrier normalization, restricted domain (#7714).

use super::super::helpers::FaceData;
use super::carrier_exact::{self as exact, Plane, P, R};
use crate::Point3;
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Shell {
    pub points: BTreeMap<u32, P>,
    pub faces: Vec<Vec<u32>>,
}

pub(crate) fn bounded_faces(count: usize) -> bool {
    (4..=32).contains(&count)
}

/// Consult the same necessary carrier selection as the normalization transaction.
/// This decides cache identity; it does not replace the STEP reference reader.
pub(crate) fn source_may_normalize(decoder: &mut EntityDecoder, id: u32) -> bool {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return false;
    };
    if entity.ifc_type != IfcType::IfcFacetedBrep {
        return false;
    }
    let Some((shell, _)) = read_shell(&entity, decoder) else {
        return false;
    };
    carrier_planes(&shell).is_some()
}

/// A cheap exact-sign precheck shared by meshing and structural hashing.
/// A conservative positive only costs a declined transaction / distinct key.
pub(crate) fn warped<T>(coords: &[T], point: impl Fn(&T) -> [f64; 3]) -> bool {
    if coords.len() < 4 {
        return false;
    }
    if coords
        .iter()
        .any(|p| point(p).iter().any(|x| !x.is_finite()))
    {
        return true;
    }
    let a = point(&coords[0]);
    // Common authored axis planes need no adaptive determinant evaluation.
    if (0..3).any(|axis| coords.iter().all(|p| point(p)[axis] == a[axis])) {
        return false;
    }
    for i in 1..coords.len() - 1 {
        let (b, c) = (point(&coords[i]), point(&coords[i + 1]));
        if [(0, 1), (0, 2), (1, 2)].iter().any(|&(x, y)| {
            geometry_predicates::orient2d([a[x], a[y]], [b[x], b[y]], [c[x], c[y]]) != 0.0
        }) {
            return coords.iter().enumerate().any(|(j, p)| {
                j != 0
                    && j != i
                    && j != i + 1
                    && geometry_predicates::orient3d(a, b, c, point(p)) != 0.0
            });
        }
    }
    false
}

#[derive(Debug)]
pub(super) struct Witness {
    pub carriers: Vec<(u32, u32)>,
    pub moved: Vec<(u32, Point3<f64>, Point3<f64>)>,
    pub context: ifc_lite_core::decoder::UniformContextPrecision,
}

pub(super) fn normalize(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    faces: &mut [FaceData],
) -> Option<Witness> {
    if entity.ifc_type != IfcType::IfcFacetedBrep
        || !bounded_faces(faces.len())
        || !faces
            .iter()
            .any(|f| warped(&f.outer_points, |p| [p.x, p.y, p.z]))
    {
        return None;
    }
    let (mut shell, face_ids) = read_shell(entity, decoder)?;
    if shell.faces.len() != faces.len() {
        return None;
    }
    let before: Vec<Vec<P>> = shell.faces.iter().map(|r| ring(&shell, r)).collect();
    let (planes, carrier_indices) = carrier_planes(&shell)?;
    let carriers = carrier_indices
        .into_iter()
        .map(|(i, j)| (face_ids[i], face_ids[j]))
        .collect();
    let context = decoder.uniform_context_precision()?.clone();
    let mut moved = Vec::new();
    let precision = R::from_float(context.precision)?;
    for (&id, old) in &mut shell.points {
        let incident: Vec<_> = shell
            .faces
            .iter()
            .zip(&planes)
            .filter(|(r, _)| r.contains(&id))
            .map(|(_, p)| p)
            .collect();
        if incident.iter().all(|p| p.contains(old)) {
            continue;
        }
        let new = exact::intersection(&incident)?;
        let delta = exact::sub(&new, old);
        if exact::dot(&delta, &delta) > &precision * &precision {
            return None;
        }
        moved.push((id, exact::rounded(old)?, exact::rounded(&new)?));
        *old = new;
    }
    super::carrier_validate::validate(&shell, &before, &planes)?;
    // Nothing is published until every carrier, finite face, edge and volume
    // invariant passes. The decoder's source coordinates remain immutable.
    let output: Option<Vec<Vec<_>>> = shell
        .faces
        .iter()
        .map(|r| {
            r.iter()
                .map(|id| exact::rounded(&shell.points[id]))
                .collect()
        })
        .collect();
    for (face, points) in faces.iter_mut().zip(output?) {
        face.outer_points = points;
    }
    Some(Witness {
        carriers,
        moved,
        context,
    })
}

/// Necessary source-only conditions, shared with cache eligibility. A warped
/// face alone must not disable structural reuse for unrepairable BREPs (#7714).
fn carrier_planes(shell: &Shell) -> Option<(Vec<Plane>, Vec<(usize, usize)>)> {
    let rings: Vec<Vec<P>> = shell.faces.iter().map(|r| ring(shell, r)).collect();
    let healthy: Vec<_> = rings
        .iter()
        .map(|r| {
            let plane = Plane::through(r)?;
            r.iter().all(|p| plane.contains(p)).then_some(plane)
        })
        .collect();
    let mut planes = Vec::new();
    let mut carriers = Vec::new();
    for i in 0..rings.len() {
        if let Some(plane) = &healthy[i] {
            planes.push(plane.clone());
            continue;
        }
        let (j, plane) = adjacent_carrier(i, shell, &rings, &healthy)?;
        carriers.push((i, j));
        planes.push(plane);
    }
    if carriers.is_empty() {
        return None;
    }
    Some((planes, carriers))
}

fn adjacent(a: &[u32], b: &[u32]) -> bool {
    (0..a.len())
        .any(|i| (0..b.len()).any(|j| a[i] == b[(j + 1) % b.len()] && a[(i + 1) % a.len()] == b[j]))
}

fn adjacent_carrier(
    i: usize,
    shell: &Shell,
    rings: &[Vec<P>],
    healthy: &[Option<Plane>],
) -> Option<(usize, Plane)> {
    let mut candidates: Vec<(usize, Plane)> = Vec::new();
    for j in 0..rings.len() {
        let Some(plane) = &healthy[j] else {
            continue;
        };
        if !adjacent(&shell.faces[i], &shell.faces[j]) {
            continue;
        }
        let on: Vec<_> = rings[i]
            .iter()
            .filter(|p| plane.contains(p))
            .cloned()
            .collect();
        if Plane::through(&on).is_some() && !candidates.iter().any(|(_, p)| p.same(plane)) {
            candidates.push((j, plane.clone()));
        }
    }
    (candidates.len() == 1).then(|| candidates.pop()).flatten()
}

pub(super) fn ring(shell: &Shell, ids: &[u32]) -> Vec<P> {
    ids.iter().map(|id| shell.points[id].clone()).collect()
}

fn read_shell(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<(Shell, Vec<u32>)> {
    let outer = decoder
        .decode_by_id(entity.ref_at(slot::IfcManifoldSolidBrep::OUTER)?)
        .ok()?;
    if outer.ifc_type != IfcType::IfcClosedShell {
        return None;
    }
    let face_ids = decoder.get_entity_ref_list_fast(outer.id)?;
    if !bounded_faces(face_ids.len()) {
        return None;
    }
    let mut shell = Shell {
        points: BTreeMap::new(),
        faces: Vec::new(),
    };
    let mut seen = BTreeSet::new();
    let mut corners = 0;
    for &id in &face_ids {
        if !seen.insert(id) || decoder.decode_by_id(id).ok()?.ifc_type != IfcType::IfcFace {
            return None;
        }
        let bounds = decoder.get_entity_ref_list_fast(id)?;
        if bounds.len() != 1 {
            return None;
        }
        let bound = decoder.decode_by_id(bounds[0]).ok()?;
        if bound.ifc_type != IfcType::IfcFaceOuterBound {
            return None;
        }
        let (loop_id, orientation, _) = decoder.get_face_bound_fast(bounds[0])?;
        if decoder.decode_by_id(loop_id).ok()?.ifc_type != IfcType::IfcPolyLoop {
            return None;
        }
        let mut ids = decoder.get_polyloop_point_ids_fast(loop_id)?;
        corners += ids.len();
        if ids.len() < 3 || corners > 128 || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
        {
            return None;
        }
        for &point_id in &ids {
            let point = decoder.decode_by_id(point_id).ok()?;
            if point.ifc_type != IfcType::IfcCartesianPoint
                || point
                    .attr(slot::IfcCartesianPoint::COORDINATES)?
                    .as_list()?
                    .len()
                    != 3
            {
                return None;
            }
            let (x, y, z) = decoder.get_cartesian_point_fast(point_id)?;
            shell
                .points
                .insert(point_id, exact::point(&Point3::new(x, y, z))?);
        }
        if shell.points.len() > 64 {
            return None;
        }
        if !orientation {
            ids.reverse();
        }
        shell.faces.push(ids);
    }
    if shell.points.values().collect::<BTreeSet<_>>().len() != shell.points.len() {
        return None;
    }
    Some((shell, face_ids))
}

#[cfg(test)]
#[path = "carrier_tests.rs"]
mod tests;
