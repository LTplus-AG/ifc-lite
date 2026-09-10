// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::flatten::{bezier, charge, distance};
use ifc_lite_geometry::{
    kernel::{predicates::orient2d, DropAxis, ImplicitPoint, Sign},
    Ring2D,
};

pub(super) struct PathRings {
    pub rings: Vec<Ring2D>,
    pub curved: Vec<bool>,
}
pub(super) fn point(m: [f64; 6], p: [f64; 2]) -> Result<[f64; 2], String> {
    let q = [
        m[0] * p[0] + m[2] * p[1] + m[4],
        m[1] * p[0] + m[3] * p[1] + m[5],
    ];
    if q.iter().any(|v| !v.is_finite() || v.abs() > 1e8) {
        return Err("PDF fill coordinate exceeds finite metric range".into());
    }
    Ok(q)
}
fn sign(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Sign {
    let explicit = |p: [f64; 2]| ImplicitPoint::Explicit([p[0], p[1], 0.]);
    orient2d(&explicit(a), &explicit(b), &explicit(c), DropAxis::Z)
}
fn convex(controls: &Ring2D, remaining: &mut u64) -> Result<(), String> {
    charge(remaining, (controls.len() as u64).pow(2))?;
    let mut winding = Sign::Zero;
    for i in 0..controls.len() {
        let a = controls[i];
        let b = controls[(i + 1) % controls.len()];
        if a == b {
            continue;
        }
        for &p in controls {
            let s = sign(a, b, p);
            if s == Sign::Zero {
                continue;
            }
            if winding != Sign::Zero && winding != s {
                return Err("PDF curved fill requires a convex control polygon; unresolved curved topology is not exported".into());
            }
            winding = s;
        }
    }
    if winding == Sign::Zero {
        return Err("PDF curved fill control polygon has no area".into());
    }
    Ok(())
}
fn finish(
    result: &mut PathRings,
    ring: &mut Ring2D,
    controls: &mut Ring2D,
    curved: &mut bool,
    remaining: &mut u64,
) -> Result<(), String> {
    if ring.len() >= 3 {
        if *curved {
            convex(controls, remaining)?;
        }
        result.rings.push(std::mem::take(ring));
        result.curved.push(*curved);
    } else if *curved {
        return Err("PDF curve collapses its filled contour".into());
    }
    ring.clear();
    controls.clear();
    *curved = false;
    Ok(())
}
pub(super) fn rings(
    commands: &[f64],
    m: [f64; 6],
    tolerance: f64,
    remaining: &mut u64,
) -> Result<PathRings, String> {
    let mut result = PathRings {
        rings: vec![],
        curved: vec![],
    };
    let mut ring = vec![];
    let mut controls = vec![];
    let mut curved = false;
    let mut cursor = 0;
    while cursor < commands.len() {
        let op = commands[cursor] as u8;
        cursor += 1;
        match op {
            0 => {
                finish(
                    &mut result,
                    &mut ring,
                    &mut controls,
                    &mut curved,
                    remaining,
                )?;
                let p = point(m, [commands[cursor], commands[cursor + 1]])?;
                cursor += 2;
                ring.push(p);
                controls.push(p);
            }
            1 => {
                let p = point(m, [commands[cursor], commands[cursor + 1]])?;
                cursor += 2;
                ring.push(p);
                controls.push(p);
            }
            2 | 3 => {
                let a = *ring.last().ok_or("PDF curve has no current point")?;
                let p = point(m, [commands[cursor], commands[cursor + 1]])?;
                let q = point(m, [commands[cursor + 2], commands[cursor + 3]])?;
                if op == 2 {
                    let end = point(m, [commands[cursor + 4], commands[cursor + 5]])?;
                    bezier([a, p, q, end], tolerance, remaining, &mut ring)?;
                    controls.extend([p, q, end]);
                    cursor += 6;
                } else {
                    bezier([a, p, q], tolerance, remaining, &mut ring)?;
                    controls.extend([p, q]);
                    cursor += 4;
                }
                curved = true;
            }
            4 => {
                let first = ring.first().copied();
                finish(
                    &mut result,
                    &mut ring,
                    &mut controls,
                    &mut curved,
                    remaining,
                )?;
                if let Some(p) = first {
                    ring.push(p);
                    controls.push(p);
                }
            }
            _ => return Err("Unknown PDF fill command".into()),
        }
    }
    finish(
        &mut result,
        &mut ring,
        &mut controls,
        &mut curved,
        remaining,
    )?;
    Ok(result)
}
/// Separation is checked before booleans, across source rings, paint boundaries
/// and CropBox. Intersections involving curves are a deliberate initial refusal.
/// A grid-only guard would say nothing about the original curve's error tube.
pub(super) fn qualify(
    paths: &[PathRings],
    clip: &[Ring2D],
    error: f64,
    remaining: &mut u64,
) -> Result<(), String> {
    let rings: Vec<_> = paths
        .iter()
        .flat_map(|p| p.rings.iter().zip(&p.curved).map(|(r, c)| (r, *c)))
        .chain(clip.iter().map(|r| (r, false)))
        .collect();
    if !rings.iter().any(|(_, c)| *c) {
        return Ok(());
    }
    let magnitude = rings
        .iter()
        .flat_map(|(r, _)| r.iter().flatten())
        .fold(1_f64, |m, x| m.max(x.abs()));
    if 128. * f64::EPSILON * magnitude >= error {
        return Err("PDF curved boundary separation is below model-coordinate precision".into());
    }
    let total: usize = rings.iter().map(|(r, _)| r.len()).sum();
    charge(remaining, (total as u64).pow(2) * 4)?;
    for i in 0..rings.len() {
        for j in i + 1..rings.len() {
            let (a, ac) = rings[i];
            let (b, bc) = rings[j];
            if !ac && !bc {
                continue;
            }
            for ai in 0..a.len() {
                for bi in 0..b.len() {
                    let (p, q) = (a[ai], a[(ai + 1) % a.len()]);
                    let (r, s) = (b[bi], b[(bi + 1) % b.len()]);
                    let crosses = sign(p, q, r) != sign(p, q, s) && sign(r, s, p) != sign(r, s, q);
                    let gap = distance(p, r, s)
                        .min(distance(q, r, s))
                        .min(distance(r, p, q))
                        .min(distance(s, p, q));
                    if crosses || gap <= error * 4. {
                        return Err("PDF curved fill boundary intersects or approaches another paint, ring or CropBox within its error envelope".into());
                    }
                }
            }
        }
    }
    Ok(())
}
