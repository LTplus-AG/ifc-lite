// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Slabs from horizontal planes.
//!
//! The outline is the plane's extent rectangle. A ceiling and a floor above
//! it pair into one slab when they are `minWallThicknessMetres..=
//! maxSlabThicknessMetres` apart and at least half of the smaller outline
//! lies over the larger one (sampled on an 8 x 8 grid): the slab between
//! two storeys, its thickness measured. Pairs are taken nearest first. An
//! unpaired floor gets `defaultSlabThicknessMetres` below it, an unpaired
//! ceiling the same above it.
use super::frame::Face;
use super::levels::{plan_contains, Level, Role};
use super::options::Params;
use super::report::{ProposalBasis, ProposalClass, ProposalGeometry, ScanProposalStats};
use super::score::{confidence, face_fit, Draft};

const OVERLAP_GRID: usize = 8;
const MIN_PAIR_OVERLAP: f64 = 0.5;

/// Share of `small`'s outline that lies over `large` in plan.
fn overlap_share(small: &Face, large: &Face) -> f64 {
    let c = small.corners;
    let mut inside = 0;
    for i in 0..OVERLAP_GRID {
        for j in 0..OVERLAP_GRID {
            let (s, t) = ((i as f64 + 0.5) / OVERLAP_GRID as f64, (j as f64 + 0.5) / OVERLAP_GRID as f64);
            let p: [f64; 2] = std::array::from_fn(|a| {
                (1. - s) * (1. - t) * c[0][a] + s * (1. - t) * c[1][a] + s * t * c[2][a] + (1. - s) * t * c[3][a]
            });
            if plan_contains(large, p, 0.) {
                inside += 1;
            }
        }
    }
    inside as f64 / (OVERLAP_GRID * OVERLAP_GRID) as f64
}

/// The outline at elevation `z`, counter-clockwise seen from above.
fn outline(face: &Face, z: f64) -> Vec<[f64; 3]> {
    let mut ring: Vec<[f64; 3]> = face.corners.iter().map(|c| [c[0], c[1], z]).collect();
    let twice_area: f64 = (0..4).map(|i| {
        let (a, b) = (ring[i], ring[(i + 1) % 4]);
        a[0] * b[1] - b[0] * a[1]
    }).sum();
    if twice_area < 0. {
        ring.reverse();
    }
    ring
}

fn draft(sources: Vec<&Face>, basis: ProposalBasis, top_face: &Face, top: f64, thickness: f64) -> Draft {
    let plan_area: f64 = {
        let c = top_face.corners;
        let e1 = [c[1][0] - c[0][0], c[1][1] - c[0][1]];
        let e2 = [c[3][0] - c[0][0], c[3][1] - c[0][1]];
        (e1[0] * e2[1] - e1[1] * e2[0]).abs()
    };
    let count = sources.len() as f64;
    let (sources, fit) = face_fit(&sources);
    let coverage = if plan_area > 0. { fit.area_square_metres / (plan_area * count) } else { 0. };
    Draft {
        class: ProposalClass::IfcSlab,
        basis,
        confidence: confidence(basis, fit.rms_metres, coverage),
        sources,
        support: fit.area_square_metres,
        fit,
        geometry: ProposalGeometry::Slab { outline: outline(top_face, top), thickness_metres: thickness },
    }
}

pub(crate) fn propose(faces: &[Face], levels: &[Level], params: &Params, stats: &mut ScanProposalStats) -> Vec<Draft> {
    let big: Vec<&Level> = levels
        .iter()
        .filter(|l| {
            let ok = faces[l.face].area >= params.min_slab_area;
            if !ok {
                stats.slabs_too_small += 1;
            }
            ok
        })
        .collect();
    let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
    for (ci, ceiling) in big.iter().enumerate().filter(|(_, l)| l.role == Role::Ceiling) {
        for (fi, floor) in big.iter().enumerate().filter(|(_, l)| l.role == Role::Floor) {
            let gap = floor.z - ceiling.z;
            if gap < params.min_thickness || gap > params.max_slab_thickness {
                continue;
            }
            let (c, f) = (&faces[ceiling.face], &faces[floor.face]);
            let (small, large) = if c.area <= f.area { (c, f) } else { (f, c) };
            if overlap_share(small, large) >= MIN_PAIR_OVERLAP {
                pairs.push((gap, ci, fi));
            }
        }
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0).then((a.1, a.2).cmp(&(b.1, b.2))));
    let mut used = vec![false; big.len()];
    let mut drafts = Vec::new();
    for (gap, ci, fi) in pairs {
        if used[ci] || used[fi] {
            continue;
        }
        used[ci] = true;
        used[fi] = true;
        let (c, f) = (&faces[big[ci].face], &faces[big[fi].face]);
        drafts.push(draft(vec![c, f], ProposalBasis::FloorCeilingPair, f, big[fi].z, gap));
        stats.paired_slabs += 1;
    }
    for (i, level) in big.iter().enumerate() {
        if used[i] {
            continue;
        }
        let face = &faces[level.face];
        let t = params.slab_thickness;
        let (basis, top) = match level.role {
            Role::Floor => (ProposalBasis::Floor, level.z),
            Role::Ceiling => (ProposalBasis::Ceiling, level.z + t),
        };
        drafts.push(draft(vec![face], basis, face, top, t));
        stats.single_slabs += 1;
    }
    drafts
}
