// SPDX-License-Identifier: MPL-2.0
//! M11-F cut-face areas through M3's prism bands (#7955): a host and convex
//! cutters with parallel WORLD axes, clipped exactly (Green integrals and
//! analytic split parameters, never a mesh). Kernel-independent rule:
//! CONNECTED coincident faces are one face owned by the earliest cut (the left
//! operand), whether the cutters overlap or abut along a boundary of positive
//! length; faces touching only at a point stay separate, and two cutter walls
//! abutting back to back are interior (no face). Anything else hinging on a
//! touching boundary is not predicted (`None`).
use super::clipping::{clipped_area, convex_planes, Edge, HalfPlane};
use super::faces::{add, key, FaceAreas};
use super::prism::{self, Basis, Prism};
use ifc_lite_processing::AnalyticQuantitySources;

const TOUCH: f64 = 1e-9;
struct Cutter { item: u32, via: u32, prism: Prism, planes: Vec<HalfPlane>, corners: Vec<[f64; 2]> }

fn items(sources: &AnalyticQuantitySources, id: u32) -> Option<Vec<u32>> {
    Some(sources.extrusion_definitions.instances.get(&id)?.iter().map(|i| i.solid_id).collect())
}
fn inside(planes: &[HalfPlane], p: [f64; 2], margin: f64) -> bool { planes.iter().all(|h| h.distance(p) > margin) }
fn length(edge: &Edge) -> f64 {
    match *edge {
        Edge::Line(a, b) => (b[0] - a[0]).hypot(b[1] - a[1]),
        // Rigid frames keep |u| = |v| = radius.
        Edge::Arc { u, sweep, .. } => u[0].hypot(u[1]) * sweep.abs(),
    }
}
fn on_arc(c: [f64; 2], u: [f64; 2], v: [f64; 2], a: f64, sweep: f64, q: [f64; 2]) -> bool {
    let w = [q[0] - c[0], q[1] - c[1]];
    let angle = (w[0] * v[0] + w[1] * v[1]).atan2(w[0] * u[0] + w[1] * u[1]);
    ((angle - a) * sweep.signum()).rem_euclid(std::f64::consts::TAU) < sweep.abs()
}
/// Parameters where the line `p + t d` meets `edge`: `(t, s)` with `s` the edge's own parameter.
fn hits(p: [f64; 2], d: [f64; 2], edge: &Edge) -> Vec<f64> {
    match *edge {
        Edge::Line(a, b) => {
            let e = [b[0] - a[0], b[1] - a[1]];
            let den = d[0] * e[1] - d[1] * e[0];
            if den == 0. { return Vec::new(); }
            let w = [a[0] - p[0], a[1] - p[1]];
            let (t, s) = ((w[0] * e[1] - w[1] * e[0]) / den, (w[0] * d[1] - w[1] * d[0]) / den);
            if (0. ..1.).contains(&s) { vec![t] } else { Vec::new() }
        }
        Edge::Arc { c, u, v, a, sweep } => {
            let r2 = u[0] * u[0] + u[1] * u[1];
            let w = [p[0] - c[0], p[1] - c[1]];
            let (qa, qb, qc) = (d[0] * d[0] + d[1] * d[1], w[0] * d[0] + w[1] * d[1], w[0] * w[0] + w[1] * w[1] - r2);
            let disc = qb * qb - qa * qc;
            if disc <= 0. { return Vec::new(); }
            [(-qb - disc.sqrt()) / qa, (-qb + disc.sqrt()) / qa].into_iter()
                .filter(|t| on_arc(c, u, v, a, sweep, [p[0] + t * d[0], p[1] + t * d[1]])).collect()
        }
    }
}
/// Even-odd test against the exact host boundary, along an irrational direction.
fn in_region(loops: &[(bool, Vec<Edge>)], p: [f64; 2]) -> bool {
    let d = [0.8191520442889918, 0.5735764363510461];
    loops.iter().flat_map(|(_, edges)| edges).flat_map(|e| hits(p, d, e)).filter(|t| *t > 0.).count() % 2 == 1
}
/// Length of a profile curve kept by `keep`, split at every cutter plane and host crossing.
fn kept(edge: &Edge, planes: &[&[HalfPlane]], host: Option<&[(bool, Vec<Edge>)]>,
    keep: impl Fn([f64; 2]) -> Option<bool>) -> Option<f64> {
    let mut ts: Vec<f64> = vec![0., 1.];
    ts.extend(planes.iter().flat_map(|p| p.iter()).flat_map(|h| edge.split_parameters(*h)));
    if let (Some(loops), Edge::Line(a, b)) = (host, edge) {
        let d = [b[0] - a[0], b[1] - a[1]];
        ts.extend(loops.iter().flat_map(|(_, e)| e).flat_map(|e| hits(*a, d, e)).filter(|t| *t > 0. && *t < 1.));
    }
    ts.sort_by(f64::total_cmp);
    ts.dedup();
    let total = length(edge);
    ts.windows(2).try_fold(0., |sum, span| {
        Some(sum + if keep(edge.point((span[0] + span[1]) / 2.))? { (span[1] - span[0]) * total } else { 0. })
    })
}
fn host_area(host: &Prism, planes: &[HalfPlane], work: &mut usize) -> Option<f64> {
    host.loops.iter().try_fold(0., |sum, (outer, edges)|
        Some(sum + if *outer { 1. } else { -1. } * clipped_area(edges, planes, work)?))
}
/// `area(H ∩ ∪A ∖ ∪B)` by inclusion-exclusion over at most eight convex cutters.
fn region(host: &Prism, a: &[&Cutter], b: &[&Cutter], work: &mut usize) -> Option<f64> {
    let planes = |set: &[&Cutter], mask: usize| -> Vec<HalfPlane> {
        (0..set.len()).filter(|i| mask & 1 << i != 0).flat_map(|i| set[i].planes.iter().copied()).collect()
    };
    let parity = |mask: usize| if mask.count_ones() % 2 == 1 { 1. } else { -1. };
    let mut total = 0.;
    for left in 1usize..1 << a.len() {
        let mut both = planes(a, left);
        let base = both.len();
        let mut removed = 0.;
        for right in 1usize..1 << b.len() {
            both.extend(planes(b, right));
            removed += parity(right) * host_area(host, &both, work)?;
            both.truncate(base);
        }
        total += parity(left) * (host_area(host, &both, work)? - removed);
    }
    Some(total)
}
/// Union-find root.
fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i { parent[i] = parent[parent[i]]; i = parent[i]; }
    i
}
/// +1 when two cutter edges lie on one line facing the same way, -1 back to back, else 0.
fn facing(a: HalfPlane, b: HalfPlane) -> i8 {
    let dot = a.n[0] * b.n[0] + a.n[1] * b.n[1];
    if dot > 1. - 1e-9 && (a.d - b.d).abs() <= TOUCH { 1 } else if dot < -1. + 1e-9 && (a.d + b.d).abs() <= TOUCH { -1 } else { 0 }
}
/// Position along an edge line's unit direction.
fn along(h: HalfPlane, p: [f64; 2]) -> f64 { p[0] * -h.n[1] + p[1] * h.n[0] }
/// Two convex caps whose interiors are disjoint join when they share a boundary
/// segment of positive length that survives inside the host and outside the
/// cutters already open there; touching only at a point keeps them apart.
fn abutting(host: &Prism, a: &Cutter, b: &Cutter, closed: &[&Cutter]) -> Option<bool> {
    let planes: Vec<&[HalfPlane]> = closed.iter().map(|c| c.planes.as_slice()).collect();
    for (ha, ea) in a.planes.iter().zip(&a.prism.loops[0].1) {
        for (_, eb) in b.planes.iter().zip(&b.prism.loops[0].1).filter(|(hb, _)| facing(*ha, **hb) == -1) {
            let (u0, u1) = (along(*ha, ea.point(0.)), along(*ha, ea.point(1.)));
            let (v0, v1) = (along(*ha, eb.point(0.)), along(*ha, eb.point(1.)));
            let (from, to) = (u0.min(u1).max(v0.min(v1)), u0.max(u1).min(v0.max(v1)));
            if to - from <= TOUCH { continue; }
            let shared = Edge::Line(ea.point((from - u0) / (u1 - u0)), ea.point((to - u0) / (u1 - u0)));
            let surviving = kept(&shared, &planes, Some(&host.loops), |p| {
                if closed.iter().any(|o| inside(&o.planes, p, -TOUCH) && !inside(&o.planes, p, TOUCH)) { return None; }
                Some(in_region(&host.loops, p) && !closed.iter().any(|o| inside(&o.planes, p, 0.)))
            })?;
            if surviving > TOUCH { return Some(true); }
        }
    }
    Some(false)
}
/// One surviving reveal span of a cutter edge line within one band.
struct Piece { group: usize, band: usize, u: [f64; 2], cutter: usize, area: f64 }
/// Reveal pieces of the cutters active in one band. A span on another cutter's
/// boundary is the same face when that cutter's wall faces the same way (it is
/// counted once, by the earlier cutter) and interior when the walls are back to
/// back; any other touching span is not predicted.
#[allow(clippy::too_many_arguments)] // One band of one host item, its cutters and their edge-line groups.
fn reveals(h: &Prism, cutters: &[Cutter], now: &[&Cutter], groups: &[Vec<usize>], band: usize, height: f64,
    pieces: &mut Vec<Piece>) -> Option<()> {
    let planes: Vec<&[HalfPlane]> = now.iter().map(|c| c.planes.as_slice()).collect();
    let index = |c: &Cutter| cutters.iter().position(|o| std::ptr::eq(o, c));
    for &c in now {
        let j = index(c)?;
        for (s, (edge, plane)) in c.prism.loops[0].1.iter().zip(&c.planes).enumerate() {
            let mut ts: Vec<f64> = vec![0., 1.];
            ts.extend(planes.iter().flat_map(|p| p.iter()).flat_map(|h| edge.split_parameters(*h)));
            if let Edge::Line(a, b) = edge {
                let d = [b[0] - a[0], b[1] - a[1]];
                ts.extend(h.loops.iter().flat_map(|(_, e)| e).flat_map(|e| hits(*a, d, e)).filter(|t| *t > 0. && *t < 1.));
            }
            ts.sort_by(f64::total_cmp);
            ts.dedup();
            'span: for span in ts.windows(2) {
                let p = edge.point((span[0] + span[1]) / 2.);
                if !in_region(&h.loops, p) { continue; }
                for &o in now.iter().filter(|o| !std::ptr::eq(**o, c)) {
                    if inside(&o.planes, p, TOUCH) { continue 'span; }
                    if !inside(&o.planes, p, -TOUCH) { continue; }
                    match o.planes.iter().map(|q| facing(*plane, *q)).find(|f| *f != 0)? {
                        1 if index(o)? > j => {}
                        _ => continue 'span,
                    }
                }
                let (u0, u1) = (along(*plane, edge.point(span[0])), along(*plane, edge.point(span[1])));
                pieces.push(Piece { group: groups[j][s], band, u: [u0.min(u1), u0.max(u1)], cutter: j,
                    area: (span[1] - span[0]) * length(edge) * height });
            }
        }
    }
    Some(())
}
/// Connected pieces of one edge line (sharing a band and touching, or in adjacent
/// bands and overlapping) are one face, keyed by its earliest cutter.
fn own(pieces: &[Piece], cutters: &[Cutter], groups: &[Vec<usize>], areas: &mut FaceAreas) {
    let mut parent: Vec<usize> = (0..pieces.len()).collect();
    for i in 0..pieces.len() {
        for k in 0..i {
            let (a, b) = (&pieces[i], &pieces[k]);
            let overlap = a.u[1].min(b.u[1]) - a.u[0].max(b.u[0]);
            if a.group == b.group && ((a.band == b.band && overlap >= -TOUCH) || (a.band.abs_diff(b.band) == 1 && overlap > TOUCH)) {
                let (x, y) = (root(&mut parent, i), root(&mut parent, k));
                parent[x.max(y)] = x.min(y);
            }
        }
    }
    let mut owner = vec![usize::MAX; pieces.len()];
    for (i, piece) in pieces.iter().enumerate() { let r = root(&mut parent, i); owner[r] = owner[r].min(piece.cutter); }
    for (i, piece) in pieces.iter().enumerate() {
        let c = owner[root(&mut parent, i)];
        let Some(s) = groups[c].iter().position(|g| *g == piece.group) else { continue };
        add(areas, key(cutters[c].item, cutters[c].via, &format!("side(0,{s})")), piece.area, false);
    }
}
/// Every cutter edge's line group: edges on one line facing the same way share it.
fn edge_groups(cutters: &[Cutter]) -> Vec<Vec<usize>> {
    let flat: Vec<(usize, usize)> = cutters.iter().enumerate().flat_map(|(j, c)| (0..c.planes.len()).map(move |s| (j, s))).collect();
    let mut parent: Vec<usize> = (0..flat.len()).collect();
    for i in 0..flat.len() {
        for k in 0..i {
            if facing(cutters[flat[i].0].planes[flat[i].1], cutters[flat[k].0].planes[flat[k].1]) == 1 {
                let (x, y) = (root(&mut parent, i), root(&mut parent, k));
                parent[x.max(y)] = x.min(y);
            }
        }
    }
    let mut groups: Vec<Vec<usize>> = cutters.iter().map(|c| vec![0; c.planes.len()]).collect();
    for (i, &(j, s)) in flat.iter().enumerate() { groups[j][s] = root(&mut parent, i); }
    groups
}
/// Convex polygons strictly apart (a separating edge line clears every corner by TOUCH).
fn separated(a: &Cutter, b: &Cutter) -> bool {
    a.planes.iter().any(|h| b.corners.iter().all(|p| h.distance(*p) < -TOUCH))
        || b.planes.iter().any(|h| a.corners.iter().all(|p| h.distance(*p) < -TOUCH))
}

/// Faces of `host` after the canonical ordered cut set (cut order = left-first).
pub fn cut(sources: &AnalyticQuantitySources, host: u32, openings: &[u32]) -> Option<FaceAreas> {
    let first = sources.extrusion_definitions.instances.get(&host)?.first()?;
    let basis = Basis::new(&prism::profile_frame(sources, first)?)?;
    let hosts = prism::prisms(sources, host, &basis)?.into_iter().zip(items(sources, host)?);
    let mut cutters = Vec::new();
    for &opening in openings {
        for (p, item) in prism::prisms(sources, opening, &basis)?.into_iter().zip(items(sources, opening)?) {
            if cutters.len() == 8 || p.loops.len() != 1 || !p.loops[0].0 { return None; }
            let planes = convex_planes(&p.loops[0].1)?;
            let corners = p.loops[0].1.iter().map(|e| e.point(0.)).collect();
            cutters.push(Cutter { item, via: opening, prism: p, planes, corners });
        }
    }
    let mut areas = FaceAreas::new();
    let mut work = 10_000_000usize;
    let groups = edge_groups(&cutters);
    for (h, host_item) in hosts {
        let curved = h.loops.iter().flat_map(|(_, e)| e).any(|e| matches!(e, Edge::Arc { .. }));
        let mut bands = vec![h.low, h.high];
        bands.extend(cutters.iter().flat_map(|c| [c.prism.low, c.prism.high]).filter(|z| *z > h.low && *z < h.high));
        bands.sort_by(f64::total_cmp);
        bands.dedup();
        let active = |z: f64| cutters.iter().filter(|c| c.prism.low < z && c.prism.high > z).collect::<Vec<_>>();
        let mut pieces = Vec::new();
        for (index, band) in bands.windows(2).enumerate() {
            let (height, now) = (band[1] - band[0], active((band[0] + band[1]) / 2.));
            let planes: Vec<&[HalfPlane]> = now.iter().map(|c| c.planes.as_slice()).collect();
            // Host sides survive unless strictly inside a cutter: a flush cutter face is the host's (left).
            for (l, (_, edges)) in h.loops.iter().enumerate() {
                for (s, edge) in edges.iter().enumerate() {
                    let outside = kept(edge, &planes, None, |p| Some(!now.iter().any(|c| inside(&c.planes, p, TOUCH))))?;
                    add(&mut areas, key(host_item, 0, &format!("side({l},{s})")), outside * height, matches!(edge, Edge::Arc { .. }));
                }
            }
            reveals(&h, &cutters, &now, &groups, index, height, &mut pieces)?;
        }
        own(&pieces, &cutters, &groups, &mut areas);
        // Host caps keep what the cutters spanning them do not remove.
        let mid = |i: usize| (bands[i] + bands[i + 1]) / 2.;
        for (z, now) in [(h.low, active(mid(0))), (h.high, active(mid(bands.len() - 2)))] {
            let role = if z == h.start { "cap(start)" } else { "cap(end)" };
            add(&mut areas, key(host_item, 0, role), host_area(&h, &[], &mut work)? - region(&h, &now, &[], &mut work)?, curved);
        }
        // Cutter caps strictly inside: floors where cutters start, heads where they end;
        // overlapping or abutting caps of one level are one face.
        for &z in &bands[1..bands.len() - 1] {
            let epsilon = TOUCH.max(z.abs() * 1e-12);
            let (below, above) = (active(z - epsilon), active(z + epsilon));
            for (open, closed) in [(&above, &below), (&below, &above)] {
                let fresh: Vec<&Cutter> = open.iter().copied().filter(|c| !closed.iter().any(|o| std::ptr::eq(*o, *c))).collect();
                // Overlapping caps, or caps sharing an edge segment, form one face; corner contact does not.
                let mut owner: Vec<usize> = (0..fresh.len()).collect();
                for i in 0..fresh.len() {
                    for k in 0..i {
                        let pair = region(&h, &[fresh[k], fresh[i]], &[], &mut work)?;
                        let apart = region(&h, &[fresh[k]], &[], &mut work)? + region(&h, &[fresh[i]], &[], &mut work)?;
                        if apart - pair > 1e-12 || (!separated(fresh[k], fresh[i]) && abutting(&h, fresh[k], fresh[i], closed)?) {
                            let (root, old) = (owner[k], owner[i]);
                            owner.iter_mut().filter(|o| **o == old).for_each(|o| *o = root);
                        }
                    }
                }
                for root in 0..fresh.len() {
                    let component: Vec<&Cutter> = (0..fresh.len()).filter(|i| owner[*i] == root).map(|i| fresh[i]).collect();
                    let Some(first) = component.first() else { continue };
                    let area = region(&h, &component, closed, &mut work)?;
                    let role = if z == first.prism.start { "cap(start)" } else { "cap(end)" };
                    if area > 0. { add(&mut areas, key(first.item, first.via, role), area, curved); }
                }
            }
        }
    }
    Some(areas)
}
