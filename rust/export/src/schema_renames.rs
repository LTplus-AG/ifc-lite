// SPDX-License-Identifier: MPL-2.0
//! Attributes a schema RENAMED IN PLACE (#7739): the one allowance table that
//! lets schema conversion trim or pad a type whose name lists are not name-wise
//! prefixes of each other only because of a rename.
//!
//! `IfcStairFlight` is `[.., Tag, NumberOfRiser, ..]` in IFC2X3 and
//! `[.., Tag, NumberOfRisers, .., PredefinedType]` in IFC4. By name neither
//! list is a prefix of the other, so before #7739 the record kept its source
//! arity and was written one slot short (up) or long (down) for the declared
//! target. Reading `NumberOfRiser` and `NumberOfRisers` as one name makes IFC2X3
//! a strict prefix of IFC4, and the ordinary trim/pad applies.
//!
//! Only renames reviewed as the same concept at the same index are listed;
//! types where a schema inserted, reordered or retyped attributes stay out,
//! because trimming or padding them would shift values into the wrong slots;
//! `schema_attr_maps` reconciles those (#10763).
//! Twin of `packages/export/src/schema-converter-renames.ts`; both are held to
//! `tests/fixtures/schema_positional_renames.json`, and the conversions they
//! allow to `tests/fixtures/schema_upconvert_sweep.json`.

/// `(entity type, [(older name, newer name)])`.
pub(crate) const POSITIONAL_RENAMES: &[(&str, &[(&str, &str)])] = &[
    ("IFCACTIONREQUEST", &[("RequestID", "Identification")]),
    ("IFCCLASSIFICATIONREFERENCE", &[("ItemReference", "Identification")]),
    ("IFCDOCUMENTREFERENCE", &[("ItemReference", "Identification")]),
    ("IFCLIBRARYREFERENCE", &[("ItemReference", "Identification")]),
    ("IFCPERMIT", &[("PermitID", "Identification")]),
    ("IFCPROJECTORDER", &[("ID", "Identification")]),
    ("IFCCOSTVALUE", &[("CostType", "Category")]),
    ("IFCSTAIRFLIGHT", &[("NumberOfRiser", "NumberOfRisers")]),
    ("IFCWORKPLAN", &[("Identifier", "Identification"), ("WorkControlType", "PredefinedType")]),
    ("IFCWORKSCHEDULE", &[("Identifier", "Identification"), ("WorkControlType", "PredefinedType")]),
    ("IFCPROPERTYBOUNDEDVALUE", &[("Description", "Specification")]),
    ("IFCPROPERTYTABLEVALUE", &[("Description", "Specification")]),
    (
        "IFCASYMMETRICISHAPEPROFILEDEF",
        &[("OverallWidth", "BottomFlangeWidth"), ("FlangeThickness", "BottomFlangeThickness"), ("FilletRadius", "BottomFlangeFilletRadius")],
    ),
    ("IFCTRANSPORTELEMENT", &[("OperationType", "PredefinedType")]),
];

/// Attributes a schema REPLACED IN PLACE (#10758): the index is the same, the
/// concept is not. `(entity type, (older name, newer name))`.
///
/// IFC4 renamed IfcAsymmetricIShapeProfileDef's `OverallWidth`,
/// `FlangeThickness` and `FilletRadius` to `BottomFlange*` (same values, in
/// [`POSITIONAL_RENAMES`]), but its slot 11 went from `CentreOfGravityInY` to
/// `BottomFlangeEdgeRadius` (IFC4 ADD2 TC1: "Name changed"). A centre of
/// gravity is not an edge radius. The pair is read as one name for the prefix
/// test, so the record still reaches the target's arity, but its value is not
/// carried: [`replaced_slot`] has the converter write `$` there and count the
/// value as dropped.
pub(crate) const POSITIONAL_REPLACEMENTS: &[(&str, (&str, &str))] =
    &[("IFCASYMMETRICISHAPEPROFILEDEF", ("CentreOfGravityInY", "BottomFlangeEdgeRadius"))];

/// `name` as the newer schema spells it, for `entity_type`.
fn newer_name<'a>(entity_type: &str, name: &'a str) -> &'a str {
    let renames = POSITIONAL_RENAMES.iter().find(|(ty, _)| *ty == entity_type).map_or(&[][..], |(_, pairs)| *pairs);
    let replaced = POSITIONAL_REPLACEMENTS.iter().find(|(ty, _)| *ty == entity_type).map(|(_, pair)| pair);
    renames.iter().chain(replaced).find(|(older, _)| *older == name).map_or(name, |(_, newer)| newer)
}

/// The index at which `entity_type`'s source list `src` and target list `tgt`
/// hold the two sides of a [`POSITIONAL_REPLACEMENTS`] pair, in either order.
pub(crate) fn replaced_slot(entity_type: &str, src: &[&str], tgt: &[&str]) -> Option<usize> {
    let (_, (older, newer)) = POSITIONAL_REPLACEMENTS.iter().find(|(ty, _)| *ty == entity_type)?;
    src.iter().zip(tgt).position(|(s, t)| (s, t) == (older, newer) || (s, t) == (newer, older))
}

/// True when `shorter` is a STRICT prefix of `longer` by attribute name, with
/// the in-place renames of `entity_type` read as one name. The longer list only
/// APPENDED attributes. Padding (`shorter` is the source) and trimming
/// (`shorter` is the target) are only safe then; many entities insert or
/// reorder attributes mid-list (IfcMaterialProperties, IfcApproval), where
/// either would shift values into the wrong slots. Twin of the TypeScript
/// `isStrictAttrPrefix`.
pub(crate) fn is_strict_attr_prefix(entity_type: &str, shorter: &[&str], longer: &[&str]) -> bool {
    shorter.len() < longer.len()
        && shorter.iter().zip(longer).all(|(s, l)| newer_name(entity_type, s) == newer_name(entity_type, l))
}

#[cfg(test)]
#[path = "schema_renames_tests.rs"]
mod tests;
