// SPDX-License-Identifier: MPL-2.0
//! Upconversion attribute PADDING for STEP schema conversion — the half of
//! `schema_convert` that a newer target schema's APPENDED attributes need.
//!
//! `schema_convert` trims trailing attributes when downgrading but, until
//! this module, never padded the ones newer schemas added (`PredefinedType`
//! on `IfcWall` / `IfcBeam` / `IfcOpeningElement` / …, `IfcMaterial`'s
//! `Description` + `Category`, …). An upgraded entity was then a positional
//! attribute short, which is an INVALID file that strict readers reject.
//! That is #1416, fixed in the TypeScript twin
//! (`packages/export/src/schema-converter.ts`) and never ported here — while
//! `ifc-lite export --format step --schema IFC4` runs THIS code, through
//! `exportStep` in the wasm bindings.
//!
//! Padding is only safe when the target schema APPENDED: many entities
//! insert or reorder attributes mid-list (`IfcMaterialProperties` goes from
//! `[Material]` to `[Name, Description, Properties, Material]`), where a
//! trailing `$` shoves the existing values into the wrong — and
//! type-invalid — slots. So the tables below carry exactly the source types
//! whose positional attribute NAME list is a strict PREFIX of the target's,
//! which is the same `isStrictAttrPrefix` test the TypeScript twin applies at
//! run time against `ENTITIES_IFC2X3` / `ENTITIES_IFC4` / `ENTITIES_IFC4X3`.
//!
//! Rust has no per-schema attribute table to test that against: the generated
//! `ifc_lite_core::IfcType` is IFC4X3 alone and carries no IFC2X3 or IFC4
//! list. The tables are therefore DERIVED from the same generated
//! buildingSMART tables the TypeScript side reads, and neither side is
//! trusted to have stayed in step: `rust/export/tests/schema_upconvert_parity.rs`
//! and `packages/export/src/schema-upconvert-sweep.parity.test.ts` run both
//! implementations over the one shared fixture
//! (`rust/export/tests/fixtures/schema_upconvert_sweep.json`), which names
//! every padded type rather than counting them.
//!
//! IFC5 is deliberately absent. The TypeScript twin has no generated table
//! for it and skips the count adjustment entirely, so upgrading to IFC5 pads
//! nothing here either.

/// `IFC2X3` -> `IFC4`: 64 source types whose attribute list the target
/// schema EXTENDS by appending. `(SOURCE TYPE, target positional count)`,
/// sorted for binary search.
static PAD_2X3_TO_4: &[(&str, usize)] = &[
    ("IFCAPPLIEDVALUE", 10),
    ("IFCBEAM", 9),
    ("IFCBUILDINGELEMENTPART", 9),
    ("IFCCLASSIFICATION", 7),
    ("IFCCOLUMN", 9),
    ("IFCCONTROL", 6),
    ("IFCCOSTITEM", 9),
    ("IFCCURTAINWALL", 9),
    ("IFCCURVESTYLE", 5),
    ("IFCDISCRETEACCESSORY", 9),
    ("IFCDISCRETEACCESSORYTYPE", 10),
    ("IFCDISTRIBUTIONCHAMBERELEMENT", 9),
    ("IFCDISTRIBUTIONPORT", 10),
    ("IFCDOOR", 13),
    ("IFCDOORLININGPROPERTIES", 17),
    ("IFCEQUIPMENTELEMENT", 9),
    ("IFCFASTENER", 9),
    ("IFCFASTENERTYPE", 10),
    ("IFCFILLAREASTYLE", 3),
    ("IFCFURNITURETYPE", 11),
    ("IFCGRID", 11),
    ("IFCISHAPEPROFILEDEF", 10),
    ("IFCMATERIAL", 3),
    ("IFCMATERIALLAYER", 7),
    ("IFCMATERIALLAYERSET", 3),
    ("IFCMATERIALLAYERSETUSAGE", 5),
    ("IFCMECHANICALFASTENER", 11),
    ("IFCMECHANICALFASTENERTYPE", 12),
    ("IFCMEMBER", 9),
    ("IFCMETRIC", 11),
    ("IFCOPENINGELEMENT", 9),
    ("IFCPLATE", 9),
    ("IFCPROCESS", 7),
    ("IFCPROJECTIONELEMENT", 9),
    ("IFCPROPERTYBOUNDEDVALUE", 6),
    ("IFCPROPERTYTABLEVALUE", 8),
    ("IFCQUANTITYAREA", 5),
    ("IFCQUANTITYCOUNT", 5),
    ("IFCQUANTITYLENGTH", 5),
    ("IFCQUANTITYTIME", 5),
    ("IFCQUANTITYVOLUME", 5),
    ("IFCQUANTITYWEIGHT", 5),
    ("IFCRAMPFLIGHT", 9),
    ("IFCREINFORCINGMESH", 18),
    ("IFCRELSEQUENCE", 9),
    ("IFCRESOURCE", 7),
    ("IFCSPACETYPE", 11),
    ("IFCSTRUCTURALANALYSISMODEL", 10),
    ("IFCSTRUCTURALCURVECONNECTION", 9),
    ("IFCSTRUCTURALCURVEMEMBER", 9),
    ("IFCSTRUCTURALCURVEMEMBERVARYING", 9),
    ("IFCSTRUCTURALPOINTCONNECTION", 9),
    ("IFCSURFACESTYLESHADING", 2),
    ("IFCSYSTEMFURNITUREELEMENTTYPE", 10),
    ("IFCTABLE", 3),
    ("IFCTELECOMADDRESS", 9),
    ("IFCTENDONANCHOR", 10),
    ("IFCTEXTSTYLE", 5),
    ("IFCTEXTURECOORDINATE", 1),
    ("IFCWALL", 9),
    ("IFCWALLSTANDARDCASE", 9),
    ("IFCWINDOW", 13),
    ("IFCWINDOWLININGPROPERTIES", 16),
    ("IFCZONE", 6),
];

/// `IFC2X3` -> `IFC4X3`: 66 source types whose attribute list the target
/// schema EXTENDS by appending. `(SOURCE TYPE, target positional count)`,
/// sorted for binary search.
static PAD_2X3_TO_4X3: &[(&str, usize)] = &[
    ("IFCANNOTATION", 8),
    ("IFCAPPLIEDVALUE", 10),
    ("IFCBEAM", 9),
    ("IFCBUILDINGELEMENTPART", 9),
    ("IFCCLASSIFICATION", 7),
    ("IFCCOLUMN", 9),
    ("IFCCONTROL", 6),
    ("IFCCOSTITEM", 9),
    ("IFCCURTAINWALL", 9),
    ("IFCCURVESTYLE", 5),
    ("IFCDERIVEDUNIT", 4),
    ("IFCDISCRETEACCESSORY", 9),
    ("IFCDISCRETEACCESSORYTYPE", 10),
    ("IFCDISTRIBUTIONCHAMBERELEMENT", 9),
    ("IFCDISTRIBUTIONPORT", 10),
    ("IFCDOOR", 13),
    ("IFCDOORLININGPROPERTIES", 17),
    ("IFCEQUIPMENTELEMENT", 9),
    ("IFCFASTENER", 9),
    ("IFCFASTENERTYPE", 10),
    ("IFCFILLAREASTYLE", 3),
    ("IFCFURNITURETYPE", 11),
    ("IFCGRID", 11),
    ("IFCISHAPEPROFILEDEF", 10),
    ("IFCMATERIAL", 3),
    ("IFCMATERIALLAYER", 7),
    ("IFCMATERIALLAYERSET", 3),
    ("IFCMATERIALLAYERSETUSAGE", 5),
    ("IFCMECHANICALFASTENER", 11),
    ("IFCMECHANICALFASTENERTYPE", 12),
    ("IFCMEMBER", 9),
    ("IFCMETRIC", 11),
    ("IFCOBJECTPLACEMENT", 1),
    ("IFCOPENINGELEMENT", 9),
    ("IFCPLATE", 9),
    ("IFCPROCESS", 7),
    ("IFCPROJECTIONELEMENT", 9),
    ("IFCQUANTITYAREA", 5),
    ("IFCQUANTITYCOUNT", 5),
    ("IFCQUANTITYLENGTH", 5),
    ("IFCQUANTITYTIME", 5),
    ("IFCQUANTITYVOLUME", 5),
    ("IFCQUANTITYWEIGHT", 5),
    ("IFCRAMPFLIGHT", 9),
    ("IFCREINFORCINGMESH", 18),
    ("IFCRELSEQUENCE", 9),
    ("IFCRESOURCE", 7),
    ("IFCSPACETYPE", 11),
    ("IFCSTRUCTURALANALYSISMODEL", 10),
    ("IFCSTRUCTURALCURVECONNECTION", 9),
    ("IFCSTRUCTURALCURVEMEMBER", 9),
    ("IFCSTRUCTURALCURVEMEMBERVARYING", 9),
    ("IFCSTRUCTURALPOINTCONNECTION", 9),
    ("IFCSURFACESTYLESHADING", 2),
    ("IFCSYSTEMFURNITUREELEMENTTYPE", 10),
    ("IFCTABLE", 3),
    ("IFCTELECOMADDRESS", 9),
    ("IFCTENDONANCHOR", 10),
    ("IFCTEXTSTYLE", 5),
    ("IFCTEXTURECOORDINATE", 1),
    ("IFCVIRTUALELEMENT", 9),
    ("IFCWALL", 9),
    ("IFCWALLSTANDARDCASE", 9),
    ("IFCWINDOW", 13),
    ("IFCWINDOWLININGPROPERTIES", 16),
    ("IFCZONE", 6),
];

/// `IFC4` -> `IFC4X3`: 5 source types whose attribute list the target
/// schema EXTENDS by appending. `(SOURCE TYPE, target positional count)`,
/// sorted for binary search.
static PAD_4_TO_4X3: &[(&str, usize)] = &[
    ("IFCANNOTATION", 8),
    ("IFCDERIVEDUNIT", 4),
    ("IFCOBJECTPLACEMENT", 1),
    ("IFCRELINTERFERESELEMENTS", 10),
    ("IFCVIRTUALELEMENT", 9),
];


/// Every `(from, to, SOURCE TYPE)` this module pads, for the cross-language
/// parity gate to re-derive its required-coverage set from rather than trust a
/// count floor (`rust/export/tests/schema_upconvert_parity.rs`).
pub fn padded_type_universe() -> Vec<(&'static str, &'static str, &'static str)> {
    [
        ("IFC2X3", "IFC4", PAD_2X3_TO_4),
        ("IFC2X3", "IFC4X3", PAD_2X3_TO_4X3),
        ("IFC4", "IFC4X3", PAD_4_TO_4X3),
    ]
    .into_iter()
    .flat_map(|(from, to, table)| table.iter().map(move |(name, _)| (from, to, *name)))
    .collect()
}

/// Positional attribute count the target schema wants for `src_type`, or
/// `None` when this conversion appends nothing to it (or is not an upgrade
/// this module knows how to pad). `from`/`to` are already canonicalized.
pub(crate) fn padded_attr_count(from: &str, to: &str, src_type: &str) -> Option<usize> {
    let table = match (from, to) {
        ("IFC2X3", "IFC4") => PAD_2X3_TO_4,
        ("IFC2X3", "IFC4X3") => PAD_2X3_TO_4X3,
        ("IFC4", "IFC4X3") => PAD_4_TO_4X3,
        _ => return None,
    };
    table
        .binary_search_by(|(name, _)| (*name).cmp(src_type))
        .ok()
        .map(|i| table[i].1)
}

/// Count top-level (comma-separated) STEP attributes, respecting nested
/// parentheses and single-quoted strings (`''` is an escaped quote, not a
/// terminator). An empty list is 0 attributes, not 1.
pub(crate) fn count_top_level_attributes(attrs: &str) -> usize {
    if attrs.trim().is_empty() {
        return 0;
    }
    let bytes = attrs.as_bytes();
    let mut count = 1usize;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i];
        if ch == b'\'' && !in_string {
            in_string = true;
        } else if ch == b'\'' && in_string {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                i += 2;
                continue;
            }
            in_string = false;
        } else if !in_string {
            match ch {
                b'(' => depth += 1,
                b')' => depth -= 1,
                b',' if depth == 0 => count += 1,
                _ => {}
            }
        }
        i += 1;
    }
    count
}
