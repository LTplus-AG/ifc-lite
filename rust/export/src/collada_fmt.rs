// SPDX-License-Identifier: MPL-2.0
//! The number-to-text half of the COLLADA writer: how an f32 becomes a token in a
//! `<float_array>`.
//!
//! Split out of `collada.rs` to keep that module under its size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`). Pure formatting, with no
//! dependency on the document assembly that stays there; the emitted text is
//! unchanged.
//!
//! Finiteness is NOT this layer's job: `<float_array>` is `xs:float`, whose only
//! non-finite lexical forms are `INF`/`-INF`/`NaN` while Rust's `Display` writes
//! `inf`/`-inf`, and by the time a value reaches here the AABB re-centring has
//! already spread one bad vertex across the whole document. That is gated once, on
//! the way in, by `crate::mesh_input`.

use std::fmt::Write as _;

/// Append space-separated floats, trimming trailing zeros for compactness while
/// keeping enough precision for metre-scale building coordinates.
pub(crate) fn append_floats(s: &mut String, vals: &[f32]) {
    for (i, v) in vals.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        let _ = write!(s, "{}", fmt_f32(*v));
    }
}

/// Format an f32 with up to 4 decimals (0.1 mm at building scale), no trailing
/// zeros — keeps the document compact (fewer chars per coordinate) while staying
/// far below any visible tolerance.
fn fmt_f32(v: f32) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let mut t = format!("{v:.4}");
    if t.contains('.') {
        while t.ends_with('0') {
            t.pop();
        }
        if t.ends_with('.') {
            t.pop();
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_trailing_zeros_and_collapses_zero() {
        let mut s = String::new();
        append_floats(&mut s, &[0.0, 1.0, 1.5, -2.25, 0.00001]);
        assert_eq!(s, "0 1 1.5 -2.25 0");
    }
}
