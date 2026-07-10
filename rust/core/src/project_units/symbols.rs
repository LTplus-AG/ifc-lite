// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Display-symbol formatting for IFC units: `IfcSIUnitName` symbols, SI prefix
//! symbols, `IfcDerivedUnit` composition (e.g. `m\u{00B3}/s`) and friendly
//! symbols for common `IfcConversionBasedUnit` names (\u{00B0}, ft, in, ...).
//!
//! Mirrored by the TypeScript `packages/parser/src/project-units.ts` and pinned
//! by the shared parity vectors.

use crate::units::get_si_prefix_multiplier;

/// Symbol for an SI prefix as it prepends a unit symbol (`k`, `m`, `\u{00B5}`, ...).
/// Unknown / empty prefix yields the empty string.
pub fn si_prefix_symbol(prefix: &str) -> &'static str {
    match prefix.trim().to_ascii_uppercase().as_str() {
        "EXA" => "E",
        "PETA" => "P",
        "TERA" => "T",
        "GIGA" => "G",
        "MEGA" => "M",
        "KILO" => "k",
        "HECTO" => "h",
        "DECA" => "da",
        "DECI" => "d",
        "CENTI" => "c",
        "MILLI" => "m",
        "MICRO" => "\u{00B5}", // micro sign
        "NANO" => "n",
        "PICO" => "p",
        "FEMTO" => "f",
        "ATTO" => "a",
        _ => "",
    }
}

/// Descriptor for an `IfcSIUnitName`.
#[derive(Clone, Copy, Debug)]
pub struct SiUnitName {
    /// Base display symbol at no prefix, e.g. `m`, `m\u{00B2}`, `g`, `Pa`.
    pub symbol: &'static str,
    /// Power the SI prefix is raised to for scale purposes: 1 normally, 2 for
    /// `SQUARE_METRE`, 3 for `CUBIC_METRE` (a `CENTI` cubic-metre is `(10^-2)^3`).
    pub prefix_power: i32,
    /// Factor that converts a value in the unprefixed unit to the canonical SI
    /// base of its dimension. `1.0` for everything except `GRAM` (base is `kg`,
    /// so a gram is `1e-3`).
    pub base_scale: f64,
}

/// Resolve an `IfcSIUnitName` enum token to its symbol descriptor.
pub fn si_unit_name(name: &str) -> Option<SiUnitName> {
    let n = name.trim().trim_matches('.').to_ascii_uppercase();
    let d = |symbol| SiUnitName { symbol, prefix_power: 1, base_scale: 1.0 };
    Some(match n.as_str() {
        "METRE" => d("m"),
        "SQUARE_METRE" => SiUnitName { symbol: "m\u{00B2}", prefix_power: 2, base_scale: 1.0 },
        "CUBIC_METRE" => SiUnitName { symbol: "m\u{00B3}", prefix_power: 3, base_scale: 1.0 },
        "GRAM" => SiUnitName { symbol: "g", prefix_power: 1, base_scale: 1e-3 },
        "SECOND" => d("s"),
        "AMPERE" => d("A"),
        "KELVIN" => d("K"),
        "MOLE" => d("mol"),
        "CANDELA" => d("cd"),
        "RADIAN" => d("rad"),
        "STERADIAN" => d("sr"),
        "HERTZ" => d("Hz"),
        "NEWTON" => d("N"),
        "PASCAL" => d("Pa"),
        "JOULE" => d("J"),
        "WATT" => d("W"),
        "COULOMB" => d("C"),
        "VOLT" => d("V"),
        "FARAD" => d("F"),
        "OHM" => d("\u{03A9}"),
        "SIEMENS" => d("S"),
        "WEBER" => d("Wb"),
        "TESLA" => d("T"),
        "HENRY" => d("H"),
        "DEGREE_CELSIUS" => d("\u{00B0}C"),
        "LUMEN" => d("lm"),
        "LUX" => d("lx"),
        "BECQUEREL" => d("Bq"),
        "GRAY" => d("Gy"),
        "SIEVERT" => d("Sv"),
        _ => return None,
    })
}

/// Symbol + SI scale for a prefixed `IfcSIUnit`.
///
/// `symbol` prepends the prefix symbol to the base (`c` + `m\u{00B2}` -> `cm\u{00B2}`);
/// `si_scale` folds `base_scale * prefix_multiplier^prefix_power` (so `cm\u{00B2}`
/// is `(10^-2)^2 = 1e-4`, `kg` is `1e-3 * 10^3 = 1.0`).
pub fn si_unit_symbol_and_scale(name: &str, prefix: Option<&str>) -> Option<(String, f64)> {
    let base = si_unit_name(name)?;
    let (prefix_sym, prefix_mult) = match prefix {
        Some(p) if !p.trim().trim_matches('.').is_empty() => {
            (si_prefix_symbol(p), get_si_prefix_multiplier(p.trim().trim_matches('.')))
        }
        _ => ("", 1.0),
    };
    let symbol = format!("{prefix_sym}{}", base.symbol);
    let scale = base.base_scale * prefix_mult.powi(base.prefix_power);
    Some((symbol, scale))
}

/// A friendly symbol for a common `IfcConversionBasedUnit` name. Falls back to
/// the cleaned name (quotes/whitespace trimmed) when unknown.
pub fn conversion_unit_symbol(name: &str) -> String {
    let clean = name.trim().trim_matches('\'').trim();
    match clean.to_ascii_uppercase().as_str() {
        "DEGREE" => "\u{00B0}".to_string(),
        "GRAD" | "GON" => "gon".to_string(),
        "MINUTE" => "\u{2032}".to_string(),
        "SECOND" => "\u{2033}".to_string(),
        "FOOT" | "FEET" => "ft".to_string(),
        "INCH" => "in".to_string(),
        "YARD" => "yd".to_string(),
        "MILE" => "mi".to_string(),
        "LITRE" | "LITER" => "L".to_string(),
        "ACRE" => "acre".to_string(),
        "POUND" | "POUND-MASS" | "LBM" => "lb".to_string(),
        "POUND-FORCE" | "LBF" => "lbf".to_string(),
        "OUNCE" => "oz".to_string(),
        "TON-METRIC" | "TONNE" => "t".to_string(),
        "PSI" => "psi".to_string(),
        "BAR" => "bar".to_string(),
        "KIP" => "kip".to_string(),
        "MINUTE-TIME" | "MIN" => "min".to_string(),
        "HOUR" => "h".to_string(),
        "DAY" => "d".to_string(),
        "BTU" => "Btu".to_string(),
        "" => "".to_string(),
        _ => clean.to_string(),
    }
}

/// Compose a derived-unit display symbol from `(element_symbol, exponent)` pairs,
/// e.g. `[("m", 3), ("s", -1)]` -> `m\u{00B3}/s`, `[("J",1),("kg",-1),("K",-1)]`
/// -> `J/(kg\u{00B7}K)`. Elements with exponent 0 are dropped. Returns an empty
/// string only when there are no non-zero elements.
pub fn compose_derived(elements: &[(String, i32)]) -> String {
    let mut num: Vec<String> = Vec::new();
    let mut den: Vec<String> = Vec::new();
    for (sym, exp) in elements {
        if *exp == 0 || sym.is_empty() {
            continue;
        }
        let mag = exp.unsigned_abs();
        let piece = format!("{sym}{}", superscript(mag as i32));
        if *exp > 0 {
            num.push(piece);
        } else {
            den.push(piece);
        }
    }
    let mid_dot = "\u{00B7}"; // middle dot
    let numerator = if num.is_empty() { "1".to_string() } else { num.join(mid_dot) };
    if den.is_empty() {
        return if num.is_empty() { String::new() } else { numerator };
    }
    let denominator = den.join(mid_dot);
    if den.len() > 1 {
        format!("{numerator}/({denominator})")
    } else {
        format!("{numerator}/{denominator}")
    }
}

/// Unicode superscript for a small magnitude exponent (1 renders as empty).
fn superscript(mag: i32) -> String {
    match mag {
        1 => String::new(),
        0 => "\u{2070}".to_string(),
        2 => "\u{00B2}".to_string(),
        3 => "\u{00B3}".to_string(),
        n if (4..=9).contains(&n) => {
            // superscript 4-9 live at U+2074..U+2079
            char::from_u32(0x2070 + n as u32).map(String::from).unwrap_or_default()
        }
        n => {
            // Multi-digit: build from digit superscripts.
            n.to_string()
                .chars()
                .map(|c| match c {
                    '0' => '\u{2070}',
                    '1' => '\u{00B9}',
                    '2' => '\u{00B2}',
                    '3' => '\u{00B3}',
                    d => char::from_u32(0x2070 + (d as u32 - '0' as u32)).unwrap_or(d),
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixed_length_symbol_and_scale() {
        let (sym, scale) = si_unit_symbol_and_scale("METRE", Some("MILLI")).unwrap();
        assert_eq!(sym, "mm");
        assert!((scale - 1e-3).abs() < 1e-15);
    }

    #[test]
    fn kilogram_folds_gram_base_scale() {
        let (sym, scale) = si_unit_symbol_and_scale("GRAM", Some("KILO")).unwrap();
        assert_eq!(sym, "kg");
        assert!((scale - 1.0).abs() < 1e-12);
    }

    #[test]
    fn prefixed_area_uses_squared_power() {
        let (sym, scale) = si_unit_symbol_and_scale("SQUARE_METRE", Some("CENTI")).unwrap();
        assert_eq!(sym, "cm\u{00B2}");
        assert!((scale - 1e-4).abs() < 1e-18);
    }

    #[test]
    fn bare_square_metre() {
        let (sym, scale) = si_unit_symbol_and_scale("SQUARE_METRE", None).unwrap();
        assert_eq!(sym, "m\u{00B2}");
        assert!((scale - 1.0).abs() < 1e-15);
    }

    #[test]
    fn derived_volumetric_flow_rate() {
        assert_eq!(
            compose_derived(&[("m".into(), 3), ("s".into(), -1)]),
            "m\u{00B3}/s"
        );
    }

    #[test]
    fn derived_specific_heat_parenthesises_denominator() {
        assert_eq!(
            compose_derived(&[("J".into(), 1), ("kg".into(), -1), ("K".into(), -1)]),
            "J/(kg\u{00B7}K)"
        );
    }

    #[test]
    fn derived_pure_inverse() {
        assert_eq!(compose_derived(&[("s".into(), -1)]), "1/s");
    }

    #[test]
    fn conversion_symbols() {
        assert_eq!(conversion_unit_symbol("'DEGREE'"), "\u{00B0}");
        assert_eq!(conversion_unit_symbol("FOOT"), "ft");
        assert_eq!(conversion_unit_symbol("MYUNIT"), "MYUNIT");
    }
}
