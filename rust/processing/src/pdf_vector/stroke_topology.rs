// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! A sufficient offset contour certificate. Wider/self-crossing strokes that
//! need arrangement repair refuse here; no topology is inferred from grid output.
use super::{curve_hulls::sign, flatten::charge};
use ifc_lite_geometry::{kernel::Sign, Ring2D};
fn on_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> bool {
    sign(a, b, p) == Sign::Zero && (0..2).all(|i| p[i] >= a[i].min(b[i]) && p[i] <= a[i].max(b[i]))
}
fn touches(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let (ab_c, ab_d, cd_a, cd_b) = (sign(a, b, c), sign(a, b, d), sign(c, d, a), sign(c, d, b));
    (ab_c != Sign::Zero
        && ab_d != Sign::Zero
        && cd_a != Sign::Zero
        && cd_b != Sign::Zero
        && ab_c != ab_d
        && cd_a != cd_b)
        || on_segment(a, c, d)
        || on_segment(b, c, d)
        || on_segment(c, a, b)
        || on_segment(d, a, b)
}
pub(super) fn qualify(rings: &[Ring2D], remaining: &mut u64) -> Result<(), String> {
    let n = rings.iter().map(Vec::len).sum::<usize>() as u64;
    charge(
        remaining,
        n.checked_mul(n)
            .and_then(|x| x.checked_mul(4))
            .ok_or("PDF stroke topology budget overflow")?,
    )?;
    for (ri, r) in rings.iter().enumerate() {
        if r.len() < 3 {
            return Err("PDF stroke offset has fewer than three vertices".into());
        }
        for i in 0..r.len() {
            let (a, b) = (r[i], r[(i + 1) % r.len()]);
            if a == b {
                return Err("PDF stroke offset contains a collapsed edge".into());
            }
            for (sj, s) in rings.iter().enumerate().skip(ri) {
                for j in 0..s.len() {
                    if ri == sj && (j <= i || j == i + 1 || (i == 0 && j + 1 == r.len())) {
                        continue;
                    }
                    if touches(a, b, s[j], s[(j + 1) % s.len()]) {
                        return Err("PDF stroke offset boundaries cross or touch; no partial page is created".into());
                    }
                }
            }
        }
    }
    Ok(())
}
