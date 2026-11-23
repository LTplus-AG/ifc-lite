// SPDX-License-Identifier: MPL-2.0
//! The entity types `schema_convert.rs`'s hand-listed `should_skip_entity`
//! does not cover: an entity whose (possibly renamed) type is entirely
//! absent from the target schema's generated entity-name table, where the
//! type is not one of `should_skip_entity`'s hand-listed alignment entities
//! either. Rust twin of `packages/export/src/schema-untranslatable.ts`
//! (#5116) — ported after that file for structural/material-profile-specific
//! renames (#5114) left this crate with NO fallback at all for the general
//! case: any such type passed through unchanged, producing an invalid
//! IFC2X3 file (the source type name and IFC4-shaped attributes shipped
//! verbatim under a header declaring IFC2X3).
//!
//! Split out of `schema_convert.rs` to stay under its line budget, same
//! reason the TypeScript twin gives for its own split.

use crate::step_slot::{slot_is, without_comments};
use ifc_lite_core::guid::{deterministic, is_valid_global_id};
use ifc_lite_core::step_encoding::decode_step_literal;
use std::borrow::Cow;

use crate::rooted_type::is_rooted_type;
use crate::schema_convert::{holds_value, schema_attribute_names};
use ifc_lite_core::slot::IfcRoot;

/// True when `type_name` (the record's possibly renamed type) can be written
/// into `to` as it is. Twin of the check in the TypeScript `convertRecord`,
/// pinned for both by `tests/fixtures/schema_unrepresented_vectors.json`
/// (#7742).
///
/// An IFC2X3 target requires the target registry to declare the type, for
/// every source (as before). An IFC4 target requires it only when the SOURCE is
/// IFC4X3 and declares the type (`declared_in_source`): that is the #7742
/// direction, IFC4X3-only resources that readers drop. IFC2X3 and IFC4 sources
/// keep main's behaviour for IFC4/IFC4X3 targets (D59): their IFC2X3-only or
/// IFC4-only non-rooted records (`IfcCalendarDate` on an `IfcClassification`)
/// are written as they are, because refusing them failed real files that
/// export on main. IFC5 has no registry and
/// accepts everything. A name neither schema knows passes through.
///
/// Until #7742 an IFC4 target was never checked here, so an IFC4X3 -> IFC4
/// export wrote every IFC4X3-only resource record (`IfcCurveSegment`,
/// `IfcClothoid`, ...) under its IFC4X3 name into a file headed `IFC4`; the
/// TypeScript twin refused it.
///
/// This crate still has no port of the TypeScript
/// `WITHHOLDABLE_UNROOTED_TYPES` omission, so every non-rooted type that fails
/// this check is refused (D3, fail closed).
pub(crate) fn has_representation(declared_in_source: bool, type_name: &str, to: &str) -> bool {
    match to {
        "IFC2X3" => {}
        "IFC4" if declared_in_source => {}
        _ => return true,
    }
    schema_attribute_names(to, type_name).is_some()
}

/// An entity type with no representation in the target schema that is
/// ALSO not an `IfcRoot` subtype, so it can be neither dropped (the
/// referencing entity would dangle) nor replaced with `IFCPROXY` (an
/// `IfcProduct`, not a valid substitute for a representation item or
/// resource type).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnrepresentedEntityError {
    pub express_id: u32,
    pub entity_type: String,
    pub to_schema: String,
}

impl std::fmt::Display for UnrepresentedEntityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Cannot convert #{} ({}) to {}: {} has no representation in {} and is not an IfcRoot \
             subtype, so it can be neither dropped (the referencing entity would dangle) nor \
             replaced with IFCPROXY (an IfcProduct, not a valid substitute for a representation \
             item or resource type). Remove or pre-convert this entity before targeting {}.",
            self.express_id, self.entity_type, self.to_schema, self.entity_type, self.to_schema,
            self.to_schema
        )
    }
}

impl std::error::Error for UnrepresentedEntityError {}

/// A plain `io::Error` boundary for the callers that already carry one
/// (`export_step_to_writer`'s `std::io::Result`) — this crate has no
/// existing typed-error channel of its own to extend, so this is the same
/// `InvalidData` classification `step_cow`/`step_text` use for a malformed
/// (rather than merely I/O-failed) input.
impl From<UnrepresentedEntityError> for std::io::Error {
    fn from(e: UnrepresentedEntityError) -> Self {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
    }
}

/// Resolve an entity whose type has NO representation at all in `to`.
///
/// A rooted (`IfcRoot`) entity safely becomes an `IFCPROXY` placeholder. Unlike
/// `should_skip_entity`'s alignment types (`schema_convert::product_proxy`),
/// it keeps only its identity: an `IfcRoot` is not necessarily an
/// `IfcProduct`, so its slots 5 and 6 need not be a placement and a
/// representation. A non-rooted entity (a representation item or resource type referenced
/// POSITIONALLY) cannot take that fallback and returns an error instead of
/// guessing; unlike the TypeScript twin, this crate has not yet ported the
/// narrow `WITHHOLDABLE_UNROOTED_TYPES` omission mechanism (#5114/#5115), so
/// every non-rooted unrepresented type errors here, with no exceptions.
pub(crate) fn resolve_unrepresented_entity(
    prefix: &str,
    entity_type: &str,
    args: &[String],
    to: &str,
    express_id: u32,
) -> Result<String, UnrepresentedEntityError> {
    if is_rooted_type(entity_type) {
        // IfcRoot begins with GlobalId, OwnerHistory, Name in every schema.
        let slot = |i: usize| {
            let value = args.get(i).map_or("", String::as_str);
            if value.contains("/*") {
                Cow::Owned(without_comments(value))
            } else {
                Cow::Borrowed(value.trim())
            }
        };
        let global_id = slot(IfcRoot::GLOBAL_ID.index());
        let guid = global_id
            .strip_prefix('\'')
            .and_then(|s| s.strip_suffix('\''))
            .filter(|id| is_valid_global_id(id));
        let guid = guid.map_or_else(
            || Cow::Owned(deterministic(&format!("ifcproxy:#{express_id}={entity_type}({})", args.join(",")))),
            Cow::Borrowed,
        );
        let name = slot(IfcRoot::NAME.index());
        // Use the source type when there is no meaningful Name for the proxy.
        let name = if decode_step_literal(name.as_bytes()).is_some_and(|s| !s.trim().is_empty()) {
            name
        } else {
            Cow::Owned(format!("'{entity_type}'"))
        };
        return Ok(format!("{prefix}IFCPROXY('{guid}',$,{name},$,$,$,$,.NOTDEFINED.,$);"));
    }
    Err(UnrepresentedEntityError {
        express_id,
        entity_type: entity_type.to_string(),
        to_schema: to.to_string(),
    })
}

/// Values without a destination on the generic proxy. GlobalId and Name have
/// slots on the proxy even when the source needs a fallback for one of them.
pub(crate) fn proxy_values_dropped(args: &[String]) -> usize {
    args.iter()
        .enumerate()
        .filter(|(i, value)| *i != IfcRoot::GLOBAL_ID.index() && *i != IfcRoot::NAME.index() && holds_value(value))
        .count()
}

/// The IFCPROXY one of `schema_convert::should_skip_entity`'s IFC4X3 alignment products
/// becomes below IFC4X3 (EXPORT-MERGE-8, #7683). All nine are IfcProduct
/// subtypes, so their first seven attributes are IfcProxy's first seven. The
/// rule, shared with the TypeScript twin's `productProxy` and pinned for both
/// by `tests/fixtures/schema_product_proxy_vectors.json`:
/// - GlobalId is the minted `guid` (the federation decision documented at the
///   call site);
/// - source attributes 1 to 6 (OwnerHistory through Representation) are kept
///   verbatim, so an alignment's curve and a referent's placement stay
///   attached;
/// - Name (IfcProxy WR1 requires it) and ObjectType take the quoted source
///   type name when the source slot is `$`;
/// - then `.NOTDEFINED.` ProxyType and a `$` Tag.
///
/// A missing source slot is written `$`.
pub(crate) fn product_proxy(prefix: &str, guid: &str, entity_type: &str, args: &[String]) -> String {
    let slot = |i: usize| args.get(i).map_or("$", String::as_str);
    // Name and ObjectType fall back to the quoted source type when the slot is `$`.
    let or_type = |i: usize| -> Cow<'_, str> {
        if slot_is(slot(i), "$") { Cow::Owned(format!("'{entity_type}'")) } else { Cow::Borrowed(slot(i)) }
    };
    format!(
        "{prefix}IFCPROXY('{guid}',{},{},{},{},{},{},.NOTDEFINED.,$);",
        slot(1),
        or_type(2),
        slot(3),
        or_type(4),
        slot(5),
        slot(6)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ifc2x3_has_no_triangulated_face_set() {
        assert!(!has_representation(true, "IFCTRIANGULATEDFACESET", "IFC2X3"));
    }

    #[test]
    fn ifc2x3_has_wall() {
        assert!(has_representation(true, "IFCWALL", "IFC2X3"));
    }

    #[test]
    fn an_ifc4_target_checks_only_types_an_ifc4x3_source_declares_7742() {
        assert!(!has_representation(true, "IFCCURVESEGMENT", "IFC4"));
        // IFC4X3 is never checked as a target (an IFC2X3/IFC4 source keeps main's behaviour, D59).
        assert!(has_representation(true, "IFCPRESENTATIONSTYLEASSIGNMENT", "IFC4X3"));
        // A name the source does not declare is not judged.
        assert!(has_representation(false, "IFCCURVESEGMENT", "IFC4"));
        assert!(has_representation(true, "IFCTRIANGULATEDFACESET", "IFC4"));
        // IFC5 has no registry.
        assert!(has_representation(true, "IFCTRIANGULATEDFACESET", "IFC5"));
    }

    #[test]
    fn rooted_unrepresented_type_becomes_a_proxy() {
        // IfcStructuralCurveReaction is an IfcProduct (rooted): IFC2X3 never
        // defined a curve/surface reaction type at all (only
        // IfcStructuralPointReaction), so this is a genuine "no
        // representation" case, not a rename gap. IFCTRIANGULATEDFACESET
        // (used above for `has_representation`) is NOT a valid example here
        // -- it's an IfcGeometricRepresentationItem, not an IfcRoot subtype.
        let out =
            resolve_unrepresented_entity("#100=", "IFCSTRUCTURALCURVEREACTION", &[], "IFC2X3", 100)
                .unwrap();
        assert!(out.contains("IFCPROXY"));
        assert!(out.contains("'IFCSTRUCTURALCURVEREACTION'"));
    }

    #[test]
    fn non_rooted_unrepresented_type_errors() {
        // A representation item, not an IfcRoot subtype -- proxying it would
        // swap one illegal file for a differently-illegal one.
        let err = resolve_unrepresented_entity("#101=", "IFCCARTESIANPOINTLIST3D", &[], "IFC2X3", 101)
            .unwrap_err();
        assert_eq!(err.express_id, 101);
        assert!(err.to_string().contains("IFCCARTESIANPOINTLIST3D"));
        assert!(err.to_string().contains("IFC2X3"));
    }
}
