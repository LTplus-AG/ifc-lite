// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Binary and disjoint-component arrangements share one paired near-band context.
use super::*;
use crate::kernel::near_band::NearBand;

pub(super) fn arrange(a: &[Tri], b: &[Tri]) -> Arrangement {
    arrange_scoped(a, b, &vec![0; b.len()], vec![NearBand::from_operands(a, b)])
}

/// Preserve disjoint subtraction's A×B-only work and source component ownership.
pub(super) fn arrange_components(a: &[Tri], comps: &[&[Tri]]) -> Arrangement {
    let mut b = Vec::new();
    let mut owners = Vec::new();
    let mut bands = Vec::with_capacity(comps.len());
    for (k, component) in comps.iter().enumerate() {
        b.extend_from_slice(component);
        owners.resize(b.len(), k);
        bands.push(NearBand::from_operands(a, component));
    }
    arrange_scoped(a, &b, &owners, bands)
}

fn arrange_scoped(a: &[Tri], b: &[Tri], parent_component_b: &[usize], bands: Vec<NearBand>) -> Arrangement {
    // 1. accumulate raw intersection segments (Segment pairs) + coplanar overlaps
    let mut raw_a: Vec<Vec<RawSeg>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut raw_b: Vec<Vec<RawSeg>> = (0..b.len()).map(|_| Vec::new()).collect();
    let mut cop_a: Vec<Vec<SupportedClip>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut cop_b: Vec<Vec<SupportedClip>> = (0..b.len()).map(|_| Vec::new()).collect();
    let mut pt_a: Vec<Vec<ImplicitPoint>> = (0..a.len()).map(|_| Vec::new()).collect();
    let mut pt_b: Vec<Vec<ImplicitPoint>> = (0..b.len()).map(|_| Vec::new()).collect();
    let pairs = crate::kernel::broadphase::candidate_pairs(a, b);
    for (i, j) in pairs {
        // Deterministic escalation guardrail (#1109): stop accumulating
        // intersections once this boolean has blown its BigRational budget. The
        // partial arrangement is discarded by the caller (csg.rs checks
        // `budget::tripped()` and falls back), so an early break is safe; it just
        // bounds the wasted work to ~one more triangle pair.
        if crate::kernel::budget::tripped() {
            break;
        }
        let (ta, tb) = (&a[i], &b[j]);
        match tri_tri_intersection_with_band(ta, tb, &bands[parent_component_b[j]]) {
            TriTri::Segment([s, t]) => {
                raw_a[i].push(RawSeg { a: s.clone(), b: t.clone(), cutter: *tb });
                raw_b[j].push(RawSeg { a: s, b: t, cutter: *ta });
            }
            TriTri::Coplanar => {
                cop_a[i].extend(clip_supported(ta, tb));
                cop_b[j].extend(clip_supported(tb, ta));
            }
            TriTri::Point(p) => {
                // Tangential touch: BOTH triangles must intern the touch point
                // as a conformity vertex. The triangle on whose EDGE the point
                // lies otherwise never splits that edge, while its neighbor
                // (which sees a full crossing segment ending there) does — a
                // T-junction that opens the surface (the flush-corner-on-
                // diagonal family; see `RetriInput::points`).
                pt_a[i].push(p.clone());
                pt_b[j].push(p);
            }
            TriTri::None => {}
        }
    }
    // Per-ORIGINAL-triangle "had a coplanar overlap with the other operand" flag,
    // captured BEFORE `build` drains the coplanar-constraint accumulators.
    let cop_parent_a: Vec<bool> = cop_a.iter().map(|c| !c.is_empty()).collect();
    let cop_parent_b: Vec<bool> = cop_b.iter().map(|c| !c.is_empty()).collect();
    let mut generated = Vec::new();
    let mut ca = mixed::build(a, &raw_a, &cop_a, &mut generated);
    let mut cb = mixed::build(b, &raw_b, &cop_b, &mut generated);
    mixed::propagate(a, &mut ca, &generated, &mut pt_a);
    mixed::propagate(b, &mut cb, &generated, &mut pt_b);
    // 3. re-triangulate each operand over the SHARED interner ⇒ conforming surfaces
    let mut interner = Interner::new();
    let mut unrecovered = 0usize;
    let (tris_a, coplanar_a, _) =
        retriangulate_each(a, &ca.constraints, &pt_a, &cop_parent_a, &mut interner, &mut unrecovered, None);
    let (tris_b, coplanar_b, component_b) =
        retriangulate_each(b, &cb.constraints, &pt_b, &cop_parent_b, &mut interner, &mut unrecovered, Some(parent_component_b));
    let n_pts = interner.len();
    Arrangement {
        interner,
        tris_a,
        tris_b,
        coplanar_a,
        coplanar_b,
        component_b,
        bands,
        unrecovered,
        f64_cache: std::cell::RefCell::new(vec![None; n_pts]),
    }
}
