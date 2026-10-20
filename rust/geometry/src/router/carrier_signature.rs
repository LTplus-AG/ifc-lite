// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{fold, parse_first_ref, FACETED_BREP_TAG};
use ifc_lite_core::EntityDecoder;

/// Cheap byte-level structural signature of an `IfcFacetedBrep`, mirroring the
/// mesher's traversal (shell → faces → bounds → loops → point coords) through the
/// SAME fast byte paths it uses on ordinary records — no per-point
/// `AttributeValue` allocation. Counts, bounds and ordered coordinates are
/// folded; warped faces also require model-scoped source identity (#7714).
///
/// Commented records consult bounded source admission for cache identity.
/// Structural surprises return `None` for a source-distinct generic signature.
pub(in crate::router) fn try_faceted_brep_signature(
    decoder: &mut EntityDecoder,
    brep_id: u32,
) -> Option<u128> {
    crate::resource::check_current().ok()?;
    // IfcFacetedBrep(#shell): a SINGLE bare ref, not a `((...))` list — so
    // `get_entity_ref_list_fast` (which expects a nested list) can't read it.
    // Parse the one shell ref straight from the brep's bytes. The shell, faces,
    // and bounds below ARE ref lists, so the fast list reader handles them.
    let (shell_id, commented) = {
        let bytes = decoder.get_raw_bytes(brep_id)?;
        (parse_first_ref(bytes)?, bytes.contains(&b'/'))
    };
    let face_ids = decoder.get_entity_ref_list_fast(shell_id)?;
    let (mut bound_ids, mut coords) = (Vec::new(), Vec::new());
    let mut acc = fold(0, FACETED_BREP_TAG);
    let mut potentially_normalized = false;
    let mut carrier_domain = crate::processors::faceted_carrier_bounded_faces(face_ids.len());
    acc = fold(acc, face_ids.len() as u64);
    for face_id in face_ids {
        decoder.get_entity_ref_list_fast_into(face_id, &mut bound_ids)?;
        acc = fold(acc, bound_ids.len() as u64);
        carrier_domain &= bound_ids.len() == 1;
        for &bound_id in &bound_ids {
            let (loop_id, orientation, is_outer) = decoder.get_face_bound_fast(bound_id)?;
            acc = fold(acc, orientation as u64);
            acc = fold(acc, is_outer as u64);
            decoder.get_polyloop_coords_cached_into(loop_id, &mut coords)?;
            carrier_domain &= (3..=128).contains(&coords.len());
            potentially_normalized |= carrier_domain
                && crate::processors::faceted_carrier_warped(&coords, |&(x, y, z)| [x, y, z]);
            acc = fold(acc, coords.len() as u64);
            for &(x, y, z) in &coords {
                acc = fold(acc, x.to_bits());
                acc = fold(acc, y.to_bits());
                acc = fold(acc, z.to_bits());
            }
        }
    }
    // #7714: model-scoped identity preserves adjacency/context through memo hits.
    let source_distinct = (commented || (carrier_domain && potentially_normalized))
        && crate::processors::faceted_carrier_source_may_normalize(decoder, brep_id);
    crate::resource::check_current().ok()?;
    Some(if source_distinct { fold(acc, brep_id as u64) } else { acc })
}
