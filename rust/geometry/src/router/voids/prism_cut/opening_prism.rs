// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Prepare opening prisms using the shared cutter/host corner reconciliation.

use super::*;

/// Build the analytic prism for one classified opening, expressed in the
/// host's local frame (`origin` subtracted in f64). `None` ⇒ the opening is
/// not a clean prism and stays with the exact kernel.
pub(super) fn prepare_prism(op: &OpeningType, host: &Mesh) -> Option<PrismFrame> {
    let origin = host.origin;
    match op {
        OpeningType::Rectangular(mn, mx, dir) => {
            let lo = [mn.x - origin[0], mn.y - origin[1], mn.z - origin[2]];
            let hi = [mx.x - origin[0], mx.y - origin[1], mx.z - origin[2]];
            if (0..3).any(|k| hi[k] - lo[k] < 1.0e-4 || !lo[k].is_finite() || !hi[k].is_finite()) {
                return None;
            }
            // Depth axis: the authored (axis-aligned) extrusion dir, else the
            // thinnest extent (the classic wall-thickness cutter).
            let k = match dir {
                Some(d) => {
                    let a = [d.x.abs(), d.y.abs(), d.z.abs()];
                    let mut k = 0;
                    for i in 1..3 {
                        if a[i] > a[k] {
                            k = i;
                        }
                    }
                    k
                }
                None => {
                    let ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
                    let mut k = 0;
                    for i in 1..3 {
                        if ext[i] < ext[k] {
                            k = i;
                        }
                    }
                    k
                }
            };
            let mut d = [0.0; 3];
            d[k] = 1.0;
            let (u, v) = basis_from_depth(d)?;
            // Axis-aligned bounds are another representation of the same
            // opening corners. Reconcile in the host frame before analytic
            // dispatch too (#7024); retain the original f64 bounds when no
            // corner qualifies. A changed box may no longer be rectangular,
            // so detect its actual prism instead of rebuilding its AABB.
            let local = GeometryRouter::make_box_mesh(
                nalgebra::Point3::from(lo), nalgebra::Point3::from(hi),
            );
            let before = local.positions.clone();
            let mut reconciled =
                crate::router::voids::synthesis::host_vertices::reconcile_with_host_vertices(
                    local, host, nalgebra::Vector3::from(d),
                );
            if reconciled.positions != before {
                reconciled.origin = origin;
                return prepare_prism(
                    &OpeningType::NonRectangular(reconciled, *mn, *mx, Some(nalgebra::Vector3::from(d))),
                    host,
                );
            }
            // Rectangle profile from the AABB corners projected to (u, v).
            let mut plo = [f64::INFINITY; 2];
            let mut phi = [f64::NEG_INFINITY; 2];
            for ci in 0..8 {
                let c = [
                    if ci & 1 == 0 { lo[0] } else { hi[0] },
                    if ci & 2 == 0 { lo[1] } else { hi[1] },
                    if ci & 4 == 0 { lo[2] } else { hi[2] },
                ];
                let uu = dot(c, u);
                let vv = dot(c, v);
                plo[0] = plo[0].min(uu);
                plo[1] = plo[1].min(vv);
                phi[0] = phi[0].max(uu);
                phi[1] = phi[1].max(vv);
            }
            let profile = vec![
                [plo[0], plo[1]],
                [phi[0], plo[1]],
                [phi[0], phi[1]],
                [plo[0], phi[1]],
            ];
            let area = (phi[0] - plo[0]) * (phi[1] - plo[1]);
            Some(PrismFrame {
                u,
                v,
                d,
                planes: vec![lo[k], hi[k]],
                profiles: vec![profile],
                slab_area: vec![area],
                slab_interior: vec![[(plo[0] + phi[0]) * 0.5, (plo[1] + phi[1]) * 0.5]],
                bb: (plo, phi),
            })
        }
        OpeningType::DiagonalRectangular(m, _) | OpeningType::NonRectangular(m, _, _, _) => {
            // A genuine prism must weld to a closed 2-manifold; the
            // self-intersecting "fin" cutters (#1007) and open shells fail
            // here and keep their exact-kernel (+ malformed-recut) treatment.
            // An opening authored as glued extrusions carries a back-to-back
            // cap membrane mid-cutter that breaks manifoldness — deseam it
            // first (the same repair every exact void path funnels through).
            let deseamed;
            let m = if cutter_is_closed_manifold(m) {
                m
            } else {
                let dir = match op {
                    OpeningType::DiagonalRectangular(_, frame) => frame.depth,
                    OpeningType::NonRectangular(_, _, _, Some(d)) => *d,
                    _ => opening_mesh_thinnest_axis_dir(m),
                };
                deseamed = GeometryRouter::remove_internal_membrane(m, dir);
                if !cutter_is_closed_manifold(&deseamed) {
                    return None;
                }
                &deseamed
            };
            // Reconcile the same authored corner before analytic dispatch as
            // before exact-kernel extension (#6940). Preserve the original f64
            // translation when no position changes, so untouched prisms retain
            // their precision and output.
            let dir = match op {
                OpeningType::DiagonalRectangular(_, frame) => frame.depth,
                OpeningType::NonRectangular(_, _, _, Some(d)) => *d,
                _ => opening_mesh_thinnest_axis_dir(m),
            };
            let local = crate::router::voids::translate_cutter_mesh(m, origin);
            let positions_before = local.positions.clone();
            let mut reconciled =
                crate::router::voids::synthesis::host_vertices::reconcile_with_host_vertices(
                    local,
                    host,
                    dir.try_normalize(crate::router::voids::NORMALIZE_EPSILON)?,
                );
            reconciled.origin = origin;
            let m = if reconciled.positions == positions_before {
                m
            } else {
                &reconciled
            };
            // Host-local f64 verts (cutter origin folded, host origin removed).
            let o = m.origin;
            let vc = m.positions.len() / 3;
            let mut raw: Vec<V3> = Vec::with_capacity(vc);
            for c in m.positions.chunks_exact(3) {
                let p = [
                    c[0] as f64 + o[0] - origin[0],
                    c[1] as f64 + o[1] - origin[1],
                    c[2] as f64 + o[2] - origin[2],
                ];
                if p.iter().any(|x| !x.is_finite()) {
                    return None;
                }
                raw.push(p);
            }
            // Enclosed volume from the raw (per-face-vertex) soup.
            let mut vol6 = 0.0;
            for t in m.indices.chunks_exact(3) {
                if t.iter().any(|&i| i as usize >= vc) {
                    return None;
                }
                let (a, b, c) = (raw[t[0] as usize], raw[t[1] as usize], raw[t[2] as usize]);
                vol6 += dot(a, cross(b, c));
            }
            // Weld by position for exact edge stitching of the cap boundary.
            let mut wverts: Vec<V3> = Vec::new();
            let mut wmap: FxHashMap<(i64, i64, i64), usize> = FxHashMap::default();
            let q = |x: f64| (x / 1.0e-6).round() as i64;
            let mut idx_of = vec![0usize; raw.len()];
            for (i, p) in raw.iter().enumerate() {
                let key = (q(p[0]), q(p[1]), q(p[2]));
                let id = *wmap.entry(key).or_insert_with(|| {
                    wverts.push(*p);
                    wverts.len() - 1
                });
                idx_of[i] = id;
            }
            let mut wtris: Vec<[usize; 3]> = Vec::with_capacity(m.indices.len() / 3);
            for t in m.indices.chunks_exact(3) {
                let a = idx_of[t[0] as usize];
                let b = idx_of[t[1] as usize];
                let c = idx_of[t[2] as usize];
                if a != b && b != c && c != a {
                    wtris.push([a, b, c]);
                }
            }
            detect_prism(&wverts, &wtris, vol6 / 6.0)
        }
    }
}

#[cfg(test)]
#[path = "opening_prism_tests.rs"]
mod tests;
