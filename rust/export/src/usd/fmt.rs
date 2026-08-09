// SPDX-License-Identifier: MPL-2.0
//! USDA lexical helpers: identifier sanitizing, string escaping, shortest-round-trip
//! number formatting, material colour keys, and the per-scope prim-name allocator.

use std::collections::HashSet;

// ── materials ───────────────────────────────────────────────────────────────

/// Material dedup key: RGBA rounded to 2 decimals, clamped to 0..=100 (matches the
/// glTF exporter's key; the clamp keeps the derived prim name a legal identifier even
/// for an out-of-gamut IFC colour).
pub(super) fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| {
        let v = if v.is_finite() { v } else { 0.0 };
        ((v * 100.0).round() as i32).clamp(0, 100)
    };
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

/// Legal-identifier material prim name from a (clamped, non-negative) colour key.
pub(super) fn mat_name(key: (i32, i32, i32, i32)) -> String {
    format!("Mat_{}_{}_{}_{}", key.0, key.1, key.2, key.3)
}

/// Clamp an RGBA colour into the [0,1] range USD expects (non-finite → mid-grey/opaque).
pub(super) fn clamp_color(c: [f32; 4]) -> [f32; 4] {
    let f = |v: f32, d: f32| if v.is_finite() { v.clamp(0.0, 1.0) } else { d };
    [f(c[0], 0.8), f(c[1], 0.8), f(c[2], 0.8), f(c[3], 1.0)]
}

// ── identifiers ───────────────────────────────────────────────────────────────

/// Map every character outside `[A-Za-z0-9_]` to `_`.
fn map_ident_chars(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect()
}

/// True when `s` begins with a legal USD identifier start (`[A-Za-z_]`).
fn starts_legally(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
}

/// Sanitize a string to a USD identifier segment: `[A-Za-z_][A-Za-z0-9_]*`. Empty or
/// leading-non-alpha inputs get the fallback prefix.
pub(super) fn sanitize_ident(s: &str, fallback: &str) -> String {
    let out = map_ident_chars(s);
    if starts_legally(&out) {
        out
    } else {
        format!("{fallback}_{out}")
    }
}

/// USD prim name for an element: sanitized display-name (or type) + `_<express id>`
/// so element siblings are always unique regardless of name collisions.
pub(super) fn prim_name(name: &str, fallback_type: &str, id: u32) -> String {
    let base = if name.trim().is_empty() { fallback_type } else { name };
    let out = map_ident_chars(base);
    let out = if starts_legally(&out) { out } else { format!("p_{out}") };
    format!("{out}_{id}")
}

// ── strings & numbers ─────────────────────────────────────────────────────────

/// Escape a Rust string for a USD `"..."` literal.
pub(super) fn escape_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {} // drop other control chars
            c => out.push(c),
        }
    }
    out
}

/// Shortest round-trip f32, with non-finite mapped to `0` (usda has no `NaN`/`inf`
/// literal spelling matching Rust's `Display`, and a non-finite slips past the gates
/// only for derived values like the mid-vertex normal of a zero-area face).
pub(super) fn fmt_f32(v: f32) -> String {
    if v.is_finite() {
        format!("{v}")
    } else {
        "0".to_string()
    }
}

/// Shortest round-trip f64, non-finite → `0`.
pub(super) fn fmt_f64(v: f64) -> String {
    if v.is_finite() {
        format!("{v}")
    } else {
        "0".to_string()
    }
}

pub(super) fn indent_str(level: usize) -> String {
    "    ".repeat(level)
}

// ── per-scope name allocator ──────────────────────────────────────────────────

/// Allocates unique child prim names within a single parent scope.
pub(super) struct Namer {
    used: HashSet<String>,
}

impl Namer {
    pub(super) fn new() -> Self {
        Self { used: HashSet::new() }
    }

    /// Reserve a name (for fixed structural children like `Looks` / `Unassigned`).
    pub(super) fn reserve(&mut self, name: &str) {
        self.used.insert(name.to_string());
    }

    /// Return `base`, or `base_2`, `base_3`, … if already taken in this scope.
    pub(super) fn alloc(&mut self, base: &str) -> String {
        if self.used.insert(base.to_string()) {
            return base.to_string();
        }
        let mut n = 2;
        loop {
            let cand = format!("{base}_{n}");
            if self.used.insert(cand.clone()) {
                return cand;
            }
            n += 1;
        }
    }
}
