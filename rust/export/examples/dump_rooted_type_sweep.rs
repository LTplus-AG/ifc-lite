// SPDX-License-Identifier: MPL-2.0
//! One-off generator, NOT part of any gate: dumps the full type-name universe
//! used to build `rust/export/tests/fixtures/rooted_type_sweep.json` --
//! every type in `ifc_lite_core::IFC_TYPES` (the generated IFC4X3 schema),
//! every bounded exporter alias, plus a couple of
//! deliberately-unknown vendor names to exercise the safe-miss direction.
//!
//! The aliases are here because a name in neither `IFC_TYPES` nor the aliases
//! would be invisible to this sweep -- which is precisely how `IFCSOLIDSTRATUM`,
//! `IFCVOIDSTRATUM` and `IFCWATERSTRATUM` classified differently in Rust and
//! JS while both halves of the parity gate stayed green (#3124 review).
//! Run with `cargo run -p ifc-lite-export --example dump_rooted_type_sweep`,
//! feed the JSON array of names to a script that queries the JS side
//! (`getInheritanceChainAcrossSchemas(type).includes('IfcRoot')`) for the
//! ground-truth `rooted` value per type, and write the combined result as
//! the fixture. The fixture itself, not this script, is what the checked-in
//! parity tests read -- this generator is not gated and not re-run in CI.

fn main() {
    let mut names: Vec<String> = ifc_lite_core::IFC_TYPES
        .iter()
        .map(|t| t.as_str().to_string())
        .collect();
    for alias in ifc_lite_core::EXPORTER_STRATUM_ALIASES {
        names.push(alias.to_string());
    }
    names.push("IFCACMEWIDGETPROXY".to_string());
    names.push("IFCVENDOREXTENSIONFOO".to_string());
    names.sort();
    names.dedup();
    println!("{}", serde_json::to_string(&names).unwrap());
}
