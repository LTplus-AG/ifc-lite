// SPDX-License-Identifier: MPL-2.0
//! Same-named attributes IFC4 RETYPED IN PLACE between a STEP enumeration and
//! a string (#10778). The slot keeps its index, so no plan touches it, but a
//! value of one type is invalid in the other: an upgraded IFC2X3
//! `IFCMONETARYUNIT(.EUR.)` put an enum into IFC4's `IfcLabel` slot, and a
//! downgraded `IFCMONETARYUNIT('EUR')` a string into IFC2X3's enum slot.
//!
//! An upgrade writes the member as a label; a downgrade writes a label that
//! names a member as that member, and anything else as `$`, counted as a
//! dropped value (the IFC2X3 slot fill then reports the required slot).
//! Twin of `packages/export/src/schema-converter-retyped.ts`; both are held to
//! `tests/fixtures/schema_retyped_slots.json`.

use crate::step_slot::split_top_level_args;

/// One retyped slot: `(type, index, IFC2X3 enumeration members)`.
pub(crate) const RETYPED_SLOTS: &[(&str, usize, &[&str])] = &[("IFCMONETARYUNIT", 0, CURRENCY)];

/// IFC2X3 `IfcCurrencyEnum`.
const CURRENCY: &[&str] = &[
    "AED", "AES", "ATS", "AUD", "BBD", "BEG", "BGL", "BHD", "BMD", "BND", "BRL", "BSD",
    "BWP", "BZD", "CAD", "CBD", "CHF", "CLP", "CNY", "CYS", "CZK", "DDP", "DEM", "DKK",
    "EGL", "EST", "EUR", "FAK", "FIM", "FJD", "FKP", "FRF", "GBP", "GIP", "GMD", "GRX",
    "HKD", "HUF", "ICK", "IDR", "ILS", "INR", "IRP", "ITL", "JMD", "JOD", "JPY", "KES",
    "KRW", "KWD", "KYD", "LKR", "LUF", "MTL", "MUR", "MXN", "MYR", "NLG", "NZD", "OMR",
    "PGK", "PHP", "PKR", "PLN", "PTN", "QAR", "RUR", "SAR", "SCR", "SEK", "SGD", "SKP",
    "THB", "TRL", "TTD", "TWD", "USD", "VEB", "VND", "XEU", "ZAR", "ZWD", "NOK",
];

/// `line`, already converted from `cfrom` to `cto`, with every retyped slot in
/// the target's type, adding to `dropped` each value that has none.
pub(crate) fn apply(line: String, cfrom: &str, cto: &str, dropped: Option<&mut usize>) -> String {
    // IFC5 holds Currency as IFC4X3 does; the retype reads values, not attribute lists.
    let ifc4_like = |s: &str| matches!(s, "IFC4" | "IFC4X3" | "IFC5");
    let up = match (cfrom, cto) {
        ("IFC2X3", to) if ifc4_like(to) => true,
        (from, "IFC2X3") if ifc4_like(from) => false,
        _ => return line,
    };
    let Some(head) = crate::step_record_frame::record_head(&line) else { return line };
    let Some(&(_, index, members)) = RETYPED_SLOTS.iter().find(|(ty, ..)| ty.eq_ignore_ascii_case(head.type_name(&line))) else { return line };
    let Some(frame) = crate::step_record_frame::record_frame(&line) else { return line };
    let Some(mut args) = split_top_level_args(frame.args(&line)) else { return line };
    let Some(slot) = args.get_mut(index) else { return line };
    let value = slot.trim();
    let written = if up {
        let Some(member) = value.strip_prefix('.').and_then(|v| v.strip_suffix('.')) else { return line };
        format!("'{member}'")
    } else {
        let Some(label) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) else { return line };
        match members.iter().find(|m| m.eq_ignore_ascii_case(label.trim())) {
            Some(member) => format!(".{member}."),
            None => {
                if let Some(dropped) = dropped { *dropped += 1; }
                "$".to_owned()
            }
        }
    };
    *slot = written;
    frame.with_args(&line, &args.join(","))
}

#[cfg(test)]
#[path = "schema_retyped_tests.rs"]
mod tests;
