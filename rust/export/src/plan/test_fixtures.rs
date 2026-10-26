// SPDX-License-Identifier: MPL-2.0
//! Synthetic, hand-written IFC fixtures shared by this module's tests. No
//! fixture here came from a real project or a real exporter; every one is
//! built from scratch to exercise one behaviour.
//!
//! Every entity line is built through [`entity_line`], which reads the
//! SCHEMA's own attribute order rather than a fixed count — `IfcWall` has 8
//! attributes in IFC2X3 and 9 in IFC4/IFC4X3 (`PredefinedType`), so a fixture
//! with a hand-counted arg list would be wrong for two of the three schemas
//! every test in this module runs against.

/// A 22-char GlobalId, distinct per `n`, using only digits (a valid
/// `IfcGloballyUniqueId` alphabet member).
pub(super) fn gid(n: u32) -> String {
    format!("{n:0>22}")
}

/// Build one record generically from the schema's own attribute order:
/// named fields go in their slot, everything else is `$`, except an IFC2X3
/// `OwnerHistory`, which that schema requires: it names the preamble's `#5`.
fn entity_line(schema: &str, id: u32, entity_type: &str, fields: &[(&str, &str)]) -> String {
    let names = ifc_lite_core::attribute_names_for_schema(schema, entity_type)
        .unwrap_or_else(|| panic!("{schema} does not declare {entity_type}"));
    let unset = |name: &str| if name == "OwnerHistory" && schema == "IFC2X3" { "#5" } else { "$" };
    let mut slots: Vec<String> = names.iter().map(|n| unset(n).to_string()).collect();
    for (i, n) in names.iter().enumerate() {
        if let Some(&(_, v)) = fields.iter().find(|(name, _)| name == n) {
            slots[i] = v.to_string();
        }
    }
    format!("#{id}={entity_type}({});\n", slots.join(","))
}

fn quoted(s: &str) -> String {
    format!("'{s}'")
}

/// One `IfcProject` + unit assignment + geometric context: the header every
/// fixture below needs so a wall's placement chain resolves, trimmed to the
/// minimum each schema requires.
fn preamble(schema: &str) -> String {
    let mut s = entity_line(
        schema,
        1,
        "IFCPROJECT",
        &[("GlobalId", &quoted(&gid(1))), ("Name", "'Project'"), ("RepresentationContexts", "(#100)"), ("UnitsInContext", "#50")],
    );
    if schema == "IFC2X3" {
        // The owner history IFC2X3 requires of every rooted record.
        s += &entity_line(schema, 5, "IFCOWNERHISTORY", &[("OwningUser", "#6"), ("OwningApplication", "#7"), ("ChangeAction", ".NOCHANGE."), ("CreationDate", "0")]);
        s += &entity_line(schema, 6, "IFCPERSONANDORGANIZATION", &[("ThePerson", "#8"), ("TheOrganization", "#9")]);
        s += &entity_line(schema, 7, "IFCAPPLICATION", &[("ApplicationDeveloper", "#9"), ("Version", "'1'"), ("ApplicationFullName", "'Fixture'"), ("ApplicationIdentifier", "'fixture'")]);
        s += &entity_line(schema, 8, "IFCPERSON", &[("Id", "'fixture'"), ("FamilyName", "'Fixture'")]);
        s += &entity_line(schema, 9, "IFCORGANIZATION", &[("Name", "'Fixture'")]);
    }
    s += "#50=IFCUNITASSIGNMENT((#51));\n";
    s += "#51=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n";
    s += "#100=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#101,$);\n";
    s += "#101=IFCAXIS2PLACEMENT3D(#102,$,$);\n";
    s += "#102=IFCCARTESIANPOINT((0.,0.,0.));\n";
    s
}

fn header(schema: &str) -> String {
    format!(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('{schema}'));\n\
         ENDSEC;\n\
         DATA;\n"
    )
}

const FOOTER: &str = "ENDSEC;\nEND-ISO-10303-21;\n";

fn wall(schema: &str, id: u32, name: &str, placement_id: u32) -> String {
    entity_line(
        schema,
        id,
        "IFCWALL",
        &[("GlobalId", &quoted(&gid(id))), ("Name", &quoted(name)), ("ObjectPlacement", &format!("#{placement_id}"))],
    )
}

fn local_placement_at(id: u32, axis_id: u32, point_id: u32, x: f64) -> String {
    format!(
        "#{id}=IFCLOCALPLACEMENT($,#{axis_id});\n#{axis_id}=IFCAXIS2PLACEMENT3D(#{point_id},$,$);\n#{point_id}=IFCCARTESIANPOINT(({},0.,0.));\n",
        step_real(x)
    )
}

/// A STEP real literal always carries a decimal point (`1.` not `1`).
fn step_real(v: f64) -> String {
    let s = format!("{v}");
    if s.contains('.') { s } else { format!("{s}.") }
}

fn single_value(id: u32, name: &str, measure: &str, literal: &str) -> String {
    format!("#{id}=IFCPROPERTYSINGLEVALUE('{name}',$,{measure}({literal}),$);\n")
}

fn pset(schema: &str, id: u32, name: &str, member_id: u32) -> String {
    entity_line(schema, id, "IFCPROPERTYSET", &[("GlobalId", &quoted(&gid(id))), ("Name", &quoted(name)), ("HasProperties", &format!("(#{member_id})"))])
}

fn defines_by_properties(schema: &str, id: u32, objects: &str, pset_id: u32) -> String {
    entity_line(
        schema,
        id,
        "IFCRELDEFINESBYPROPERTIES",
        &[("GlobalId", &quoted(&gid(id))), ("RelatedObjects", objects), ("RelatingPropertyDefinition", &format!("#{pset_id}"))],
    )
}

/// One wall (`#10`) with its own unshared `IfcLocalPlacement` (`#20` ->
/// `#21`/`#22`), and one occurrence property set `Pset_WallCommon.FireRating`
/// (`#30`/`#31`/`#32`) attached only to it.
pub(super) fn wall_with_own_pset(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &single_value(30, "FireRating", "IFCLABEL", "'1HR'");
    data += &pset(schema, 31, "Pset_WallCommon", 30);
    data += &defines_by_properties(schema, 32, "(#10)", 31);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// Two walls (`#10`, `#11`) sharing one `Pset_WallCommon` (`#31`) through one
/// `IfcRelDefinesByProperties` (`#32`) naming both.
pub(super) fn two_walls_sharing_a_pset(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &wall(schema, 11, "Wall 2", 23);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &local_placement_at(23, 24, 25, 1.0);
    data += &single_value(30, "FireRating", "IFCLABEL", "'1HR'");
    data += &pset(schema, 31, "Pset_WallCommon", 30);
    data += &defines_by_properties(schema, 32, "(#10,#11)", 31);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// Three walls (`#10`, `#11`, `#12`) sharing one `Pset_WallCommon` (`#31`)
/// through one `IfcRelDefinesByProperties` (`#32`) naming all three — enough
/// members that a plan can delete one and patch another's copy of the same
/// pset while the third is left alone as a witness.
pub(super) fn three_walls_sharing_a_pset(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &wall(schema, 11, "Wall 2", 23);
    data += &wall(schema, 12, "Wall 3", 26);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &local_placement_at(23, 24, 25, 1.0);
    data += &local_placement_at(26, 27, 28, 2.0);
    data += &single_value(30, "FireRating", "IFCLABEL", "'1HR'");
    data += &pset(schema, 31, "Pset_WallCommon", 30);
    data += &defines_by_properties(schema, 32, "(#10,#11,#12)", 31);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// Two walls (`#10`, `#11`) sharing one `Qto_WallBaseQuantities` (`#31`,
/// carrying `IfcQuantityLength.Length` `#30`) through one
/// `IfcRelDefinesByProperties` (`#32`) naming both — the quantity-set twin of
/// [`two_walls_sharing_a_pset`].
pub(super) fn two_walls_sharing_a_quantity_set(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &wall(schema, 11, "Wall 2", 23);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &local_placement_at(23, 24, 25, 1.0);
    data += &entity_line(schema, 30, "IFCQUANTITYLENGTH", &[("Name", "'Length'"), ("LengthValue", "3.")]);
    data += &entity_line(
        schema,
        31,
        "IFCELEMENTQUANTITY",
        &[("GlobalId", &quoted(&gid(31))), ("Name", "'Qto_WallBaseQuantities'"), ("Quantities", "(#30)")],
    );
    data += &defines_by_properties(schema, 32, "(#10,#11)", 31);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// One wall (`#10`), its type (`#40`) carrying `Pset_WallCommon.FireRating`
/// (`#41`/`#42`), and the `IfcRelDefinesByType` (`#43`) linking them.
pub(super) fn wall_with_type_owned_pset(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &entity_line(
        schema,
        40,
        "IFCWALLTYPE",
        &[("GlobalId", &quoted(&gid(40))), ("Name", "'WallType 1'"), ("HasPropertySets", "(#42)"), ("PredefinedType", ".NOTDEFINED.")],
    );
    data += &single_value(41, "FireRating", "IFCLABEL", "'2HR'");
    data += &pset(schema, 42, "Pset_WallCommon", 41);
    data += &entity_line(
        schema,
        43,
        "IFCRELDEFINESBYTYPE",
        &[("GlobalId", &quoted(&gid(43))), ("RelatedObjects", "(#10)"), ("RelatingType", "#40")],
    );
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// [`wall_with_type_owned_pset`] with the type carrying a quantity set
/// instead: `Qto_WallBaseQuantities.Length` (`#41`/`#42`).
pub(super) fn wall_with_type_owned_quantity_set(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &entity_line(
        schema,
        40,
        "IFCWALLTYPE",
        &[("GlobalId", &quoted(&gid(40))), ("Name", "'WallType 1'"), ("HasPropertySets", "(#42)"), ("PredefinedType", ".NOTDEFINED.")],
    );
    data += &entity_line(schema, 41, "IFCQUANTITYLENGTH", &[("Name", "'Length'"), ("LengthValue", "3.")]);
    data += &entity_line(
        schema,
        42,
        "IFCELEMENTQUANTITY",
        &[("GlobalId", &quoted(&gid(42))), ("Name", "'Qto_WallBaseQuantities'"), ("Quantities", "(#41)")],
    );
    data += &entity_line(
        schema,
        43,
        "IFCRELDEFINESBYTYPE",
        &[("GlobalId", &quoted(&gid(43))), ("RelatedObjects", "(#10)"), ("RelatingType", "#40")],
    );
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// One wall (`#10`) with two of its OWN unshared occurrence psets
/// (`#41` `Pset_A`, `#42` `Pset_B`), each attached through its own
/// `IfcRelDefinesByProperties` (`#43`, `#44`), but both listing the SAME
/// leaf value (`#30`, `Reference`) — the shape an exporter produces when it
/// deduplicates identical property values across sets that happen to agree,
/// even though neither SET is itself shared.
pub(super) fn two_sets_on_one_wall_sharing_a_leaf(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &single_value(30, "Reference", "IFCIDENTIFIER", "'R-1'");
    data += &pset(schema, 41, "Pset_A", 30);
    data += &pset(schema, 42, "Pset_B", 30);
    data += &defines_by_properties(schema, 43, "(#10)", 41);
    data += &defines_by_properties(schema, 44, "(#10)", 42);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// The two-wall twin of [`two_sets_on_one_wall_sharing_a_leaf`]: `Pset_A`
/// (`#41`, via `#43`) belongs to wall `#10` alone, `Pset_B` (`#42`, via
/// `#44`) belongs to wall `#11` alone — each set individually unshared, one
/// object apiece — but both list the same leaf (`#30`).
pub(super) fn two_walls_separate_sets_sharing_a_leaf(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &wall(schema, 11, "Wall 2", 23);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &local_placement_at(23, 24, 25, 1.0);
    data += &single_value(30, "Reference", "IFCIDENTIFIER", "'R-1'");
    data += &pset(schema, 41, "Pset_A", 30);
    data += &pset(schema, 42, "Pset_B", 30);
    data += &defines_by_properties(schema, 43, "(#10)", 41);
    data += &defines_by_properties(schema, 44, "(#11)", 42);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// One wall (`#10`) whose OWN occurrence pset (`#41`, via `#43`) and whose
/// type's (`#40`) own pset (`#42`, via the `IfcRelDefinesByType` `#44`)
/// share the exact same leaf value (`#30`, `FireRating`) — sharing across an
/// occurrence override and a type default, not between two occurrences.
pub(super) fn leaf_shared_by_occurrence_and_type(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &single_value(30, "FireRating", "IFCLABEL", "'1HR'");
    data += &pset(schema, 41, "Pset_WallCommon", 30);
    data += &defines_by_properties(schema, 43, "(#10)", 41);
    data += &entity_line(
        schema,
        40,
        "IFCWALLTYPE",
        &[("GlobalId", &quoted(&gid(40))), ("Name", "'WallType 1'"), ("HasPropertySets", "(#42)"), ("PredefinedType", ".NOTDEFINED.")],
    );
    data += &pset(schema, 42, "Pset_WallCommon", 30);
    data += &entity_line(
        schema,
        44,
        "IFCRELDEFINESBYTYPE",
        &[("GlobalId", &quoted(&gid(44))), ("RelatedObjects", "(#10)"), ("RelatingType", "#40")],
    );
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// The quantity twin of [`two_sets_on_one_wall_sharing_a_leaf`]: two element
/// quantity sets (`#41` `Qto_A`, `#42` `Qto_B`) on one wall, each unshared,
/// both listing the same `IfcQuantityLength` leaf (`#30`, `Length`).
pub(super) fn two_quantity_sets_on_one_wall_sharing_a_leaf(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &entity_line(schema, 30, "IFCQUANTITYLENGTH", &[("Name", "'Length'"), ("LengthValue", "3.")]);
    data += &entity_line(schema, 41, "IFCELEMENTQUANTITY", &[("GlobalId", &quoted(&gid(41))), ("Name", "'Qto_A'"), ("Quantities", "(#30)")]);
    data += &entity_line(schema, 42, "IFCELEMENTQUANTITY", &[("GlobalId", &quoted(&gid(42))), ("Name", "'Qto_B'"), ("Quantities", "(#30)")]);
    data += &defines_by_properties(schema, 43, "(#10)", 41);
    data += &defines_by_properties(schema, 44, "(#10)", 42);
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// [`two_walls_sharing_a_pset`] (`#10`, `#11` share `Pset_WallCommon` `#31`
/// via `#32`) plus a third wall (`#12`) with its own unshared pset
/// (`Pset_Other` `#33`, via `#34`) that happens to reference the SAME leaf
/// (`#30`) the shared group's pset uses — set-level and leaf-level sharing
/// on the same value at once, so patching into the group must clone the
/// leaf exactly once, inside the set-level clone, and never touch `#33`.
pub(super) fn two_walls_sharing_a_pset_plus_a_third_sharing_the_leaf(schema: &str) -> Vec<u8> {
    let base = String::from_utf8(two_walls_sharing_a_pset(schema)).unwrap();
    let body = base.strip_suffix(FOOTER).expect("two_walls_sharing_a_pset ends with the standard footer");
    let mut data = body.to_string();
    data += &wall(schema, 12, "Wall 3", 26);
    data += &local_placement_at(26, 27, 28, 2.0);
    data += &pset(schema, 33, "Pset_Other", 30);
    data += &defines_by_properties(schema, 34, "(#12)", 33);
    data += FOOTER;
    data.into_bytes()
}

/// One aggregation: `#1` (the project) aggregates a single building `#60`
/// via `IfcRelAggregates` `#61`, exercising a mandatory `SET [1:?]` going
/// empty when `#60` is deleted.
pub(super) fn project_aggregates_one_building(schema: &str) -> Vec<u8> {
    let mut data = entity_line(schema, 60, "IFCBUILDING", &[("GlobalId", &quoted(&gid(60))), ("Name", "'Building'")]);
    data += &entity_line(
        schema,
        61,
        "IFCRELAGGREGATES",
        &[("GlobalId", &quoted(&gid(61))), ("RelatingObject", "#1"), ("RelatedObjects", "(#60)")],
    );
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

/// [`wall_with_type_owned_pset`] where the wall also names the type's set
/// `#42` through its own `IfcRelDefinesByProperties` (`#44`), as some
/// exporters write it.
pub(super) fn pset_on_type_and_occurrence(schema: &str) -> Vec<u8> {
    pset_on_type_also_related_to(schema, "(#10)")
}

/// [`wall_with_type_owned_pset`] plus an `IfcRelDefinesByProperties`
/// (`#44`) relating the type's set `#42` to `related`.
pub(super) fn pset_on_type_also_related_to(schema: &str, related: &str) -> Vec<u8> {
    let mut content = wall_with_type_owned_pset(schema);
    let footer_at = content.len() - FOOTER.len();
    let rel = defines_by_properties(schema, 44, related, 42);
    content.splice(footer_at..footer_at, rel.into_bytes());
    content
}

/// One wall (`#10`) covered by one covering (`#12`) through
/// `IfcRelCoversBldgElements` (`#13`, whose `RelatedCoverings` is `SET [1:?]`).
pub(super) fn wall_with_one_covering(schema: &str) -> Vec<u8> {
    let mut data = wall(schema, 10, "Wall 1", 20);
    data += &local_placement_at(20, 21, 22, 0.0);
    data += &entity_line(schema, 12, "IFCCOVERING", &[("GlobalId", &quoted(&gid(12))), ("Name", "'Cladding'")]);
    data += &entity_line(
        schema,
        13,
        "IFCRELCOVERSBLDGELEMENTS",
        &[("GlobalId", &quoted(&gid(13))), ("RelatingBuildingElement", "#10"), ("RelatedCoverings", "(#12)")],
    );
    format!("{}{}{}{}", header(schema), preamble(schema), data, FOOTER).into_bytes()
}

// The geometry and Add scenes, apart so neither file outgrows the module-size
// rule; they build on the helpers above.
#[path = "test_fixtures_scenes.rs"]
mod scenes;
pub(super) use scenes::{products_with_geometry, storey_with_headroom, storey_with_typed_wall};

// The delete scene, apart for the same reason.
#[path = "test_fixtures_delete.rs"]
mod delete_scene;
pub(super) use delete_scene::host_with_port_type_and_body;
