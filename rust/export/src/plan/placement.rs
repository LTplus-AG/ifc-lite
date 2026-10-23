// SPDX-License-Identifier: MPL-2.0
//! Placement patch: rewrite a product's `IfcLocalPlacement`
//! `RelativePlacement` from a caller-supplied 4x4, relative to whatever
//! `PlacementRelTo` already names — that attribute is never touched, so the
//! parent relationship the source encoded stays exactly as it was.
//!
//! The new `Location`/`Axis`/`RefDirection` are written as fresh
//! `IfcCartesianPoint`/`IfcDirection` records rather than edited in place,
//! even when the old ones are unshared: `IfcAxis2Placement3D` is itself
//! usually unshared but its `Location`/`Axis` sub-records occasionally are
//! (two placements at the same origin), and this executor has no per-slot
//! sharing check finer than the placement record itself. Always appending
//! keeps that case from silently repointing someone else's origin.
//!
//! The old chain does not just sit there unreferenced: [`sweep_orphans`]
//! walks forward from the one edge this patch actually removed
//! (`RelativePlacement` no longer names the old `IfcAxis2Placement3D`) and
//! prunes whatever that leaves with no OTHER referrer, cascading into the
//! old point/directions the same way. It starts from that one known edge,
//! not from a whole-file walk, so it can only ever remove something THIS
//! patch orphaned — a record still shared elsewhere keeps a referrer and
//! stops the walk, and a record that was already unreferenced in the source
//! is never visited at all.

use std::collections::{HashSet, VecDeque};

use ifc_lite_geometry::math::v3::{cross, dot};

use crate::step_ids::IdAllocator;

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::types::PlacementPatch;

#[derive(Debug)]
pub(crate) struct PlacementWrite {
    /// New records to append, in order, already STEP-serialized without a
    /// trailing newline.
    pub(crate) new_records: Vec<(u32, String)>,
    /// The existing `IfcLocalPlacement`'s `RelativePlacement` attribute
    /// index and its new value (a `#ref` to the freshly appended
    /// `IfcAxis2Placement3D`).
    pub(crate) repoint: (u32, usize, String),
    /// Records this patch's OWN redirect leaves with no referrer at all,
    /// found by [`sweep_orphans`] — the caller drops these from the output.
    pub(crate) orphaned: HashSet<u32>,
}

pub(crate) fn resolve_placement(
    index: &FileIndex,
    file_schema: &str,
    object_id: u32,
    patch: &PlacementPatch,
    ids: &mut IdAllocator,
) -> Result<PlacementWrite, String> {
    let object_type = index.type_of(object_id).unwrap_or_default();
    let op_idx = attribute_index(file_schema, &object_type, "ObjectPlacement")
        .ok_or_else(|| format!("{object_type} has no ObjectPlacement attribute in {file_schema}"))?;
    let placement_id = index
        .attrs(object_id)
        .and_then(|a| a.get(op_idx).and_then(|a| a.scalar))
        .ok_or("object carries no ObjectPlacement reference to patch")?;
    let placement_type = index.type_of(placement_id).unwrap_or_default();
    if placement_type == "IFCGRIDPLACEMENT" {
        return Err("IfcGridPlacement is grid-relative, not a local transform this executor can rewrite".into());
    }
    if placement_type == "IFCLINEARPLACEMENT" {
        return Err("IfcLinearPlacement is curve-relative, not a local transform this executor can rewrite".into());
    }
    if placement_type != "IFCLOCALPLACEMENT" {
        return Err(format!("ObjectPlacement is {placement_type}, not an IfcLocalPlacement"));
    }

    // Shared when more than one product's OWN ObjectPlacement names this
    // same IfcLocalPlacement — not counting a child's PlacementRelTo chain,
    // which is the normal parent/child shape and not what "shared" means
    // here.
    let sharing_products: HashSet<u32> = index
        .referrers(placement_id)
        .iter()
        .filter(|&&(referrer, idx)| {
            let rtype = index.type_of(referrer).unwrap_or_default();
            attribute_index(file_schema, &rtype, "ObjectPlacement") == Some(idx)
        })
        .map(|&(referrer, _)| referrer)
        .collect();
    if sharing_products.len() > 1 {
        return Err(format!(
            "IfcLocalPlacement #{placement_id} is shared by {} products; refusing rather than moving them together",
            sharing_products.len()
        ));
    }

    let relplacement_idx = attribute_index(file_schema, "IFCLOCALPLACEMENT", "RelativePlacement")
        .ok_or("IFCLOCALPLACEMENT has no RelativePlacement attribute in this schema")?;
    let old_axis_placement = index.attrs(placement_id).and_then(|a| a.get(relplacement_idx).and_then(|a| a.scalar));

    let (new_records, a2p_id) = axis_placement_records(&patch.matrix, ids)?;

    let orphaned = match old_axis_placement {
        Some(old) => sweep_orphans(index, placement_id, old),
        None => HashSet::new(),
    };

    Ok(PlacementWrite { new_records, repoint: (placement_id, relplacement_idx, format!("#{a2p_id}")), orphaned })
}

/// Walk forward from the one edge `from -> to` that a redirect just
/// removed: if `to` has no OTHER live referrer, it is orphaned by this
/// patch alone, so it is pruned and the walk continues from ITS own
/// outgoing references (the old point/directions), each checked the same
/// way. `IfcProject` is the only protected stop — everything else is judged
/// purely by whether removing this one edge left it referenced.
///
/// "Other live referrer" is counted, not listed: `to`'s distinct referrers,
/// less those among `from` and what this sweep already removed (each of
/// which is checked by reading its own references). A `to` whose count has
/// not been collected yet is treated as still referenced this round.
fn sweep_orphans(index: &FileIndex, from: u32, to: u32) -> HashSet<u32> {
    let mut removed = HashSet::new();
    let mut queue: VecDeque<(u32, u32)> = VecDeque::new();
    queue.push_back((from, to));
    while let Some((from, to)) = queue.pop_front() {
        if removed.contains(&to) {
            continue;
        }
        if index.type_of(to).as_deref() == Some("IFCPROJECT") {
            continue;
        }
        let Some(referrers) = index.referrer_count(to) else { continue };
        let gone = removed
            .iter()
            .copied()
            .chain((!removed.contains(&from)).then_some(from))
            .filter(|&r| index.refs_of(r).contains(&to))
            .count();
        if referrers <= gone {
            removed.insert(to);
            for target in index.refs_of(to) {
                queue.push_back((to, target));
            }
        }
    }
    removed
}

/// Refuse a matrix that cannot become an `IfcAxis2Placement3D`: a
/// non-finite entry (not a STEP real), or anything beyond a rotation and a
/// translation. The placement holds only its Z and X axes, so a zero or
/// parallel pair, a reflection, scale, shear or projective row would be
/// dropped without a word.
pub(crate) fn check_matrix(m: &[[f64; 4]; 4]) -> Result<(), String> {
    if m.iter().flatten().any(|v| !v.is_finite()) {
        return Err("placement matrix has a non-finite entry".into());
    }
    let col = |c: usize| [m[0][c], m[1][c], m[2][c]];
    let (x, y, z) = (col(0), col(1), col(2));
    let unit = |v: [f64; 3]| (dot(v, v) - 1.0).abs() <= 1e-6;
    let orthogonal = dot(x, y).abs() <= 1e-6 && dot(y, z).abs() <= 1e-6 && dot(z, x).abs() <= 1e-6;
    let right_handed = dot(cross(x, y), z) > 0.0;
    let affine = (m[3][0].abs() + m[3][1].abs() + m[3][2].abs() + (m[3][3] - 1.0).abs()) <= 1e-9;
    if !(unit(x) && unit(y) && unit(z) && orthogonal && right_handed && affine) {
        return Err("placement matrix is not a rotation and a translation".into());
    }
    Ok(())
}

/// A fresh `IfcAxis2Placement3D` for `matrix` (row-major; translation in
/// the last column, local Z in the third, local X in the first), with its
/// own point and directions. Returns the records in order and the axis
/// placement's id. Shared by the placement patch and by
/// [`super::Disposition::Add`], so there is one reading of the matrix.
pub(crate) fn axis_placement_records(
    m: &[[f64; 4]; 4],
    ids: &mut IdAllocator,
) -> Result<(Vec<(u32, String)>, u32), String> {
    check_matrix(m)?;
    let location = (m[0][3], m[1][3], m[2][3]);
    let axis = (m[0][2], m[1][2], m[2][2]);
    let ref_dir = (m[0][0], m[1][0], m[2][0]);

    let cp_id = ids.allocate().ok_or("id space exhausted while writing a placement")?;
    let axis_id = ids.allocate().ok_or("id space exhausted while writing a placement")?;
    let refdir_id = ids.allocate().ok_or("id space exhausted while writing a placement")?;
    let a2p_id = ids.allocate().ok_or("id space exhausted while writing a placement")?;

    let records = vec![
        (cp_id, format!("#{cp_id}=IFCCARTESIANPOINT(({},{},{}));", fmt(location.0), fmt(location.1), fmt(location.2))),
        (axis_id, format!("#{axis_id}=IFCDIRECTION(({},{},{}));", fmt(axis.0), fmt(axis.1), fmt(axis.2))),
        (refdir_id, format!("#{refdir_id}=IFCDIRECTION(({},{},{}));", fmt(ref_dir.0), fmt(ref_dir.1), fmt(ref_dir.2))),
        (a2p_id, format!("#{a2p_id}=IFCAXIS2PLACEMENT3D(#{cp_id},#{axis_id},#{refdir_id});")),
    ];
    Ok((records, a2p_id))
}

/// A STEP real literal always carries a decimal point (`1.` not `1`).
pub(crate) fn fmt(v: f64) -> String {
    let s = format!("{v}");
    if s.contains('.') { s } else { format!("{s}.") }
}

#[cfg(test)]
#[path = "placement_tests.rs"]
mod tests;
