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

use crate::generated::ifc2x3_entity_names::IFC2X3_ENTITY_NAMES;
use crate::rooted_type::is_rooted_type;
use crate::schema_convert::placeholder_guid;

/// True when `type_name` has no representation at all in `to` — distinct
/// from a renamed or attribute-count-adjusted counterpart, which
/// `schema_convert.rs`'s rename tables already resolve before this runs.
///
/// Only meaningful for an IFC2X3 target today: that is the one direction
/// with a generated per-schema entity-name table to check against (mirrors
/// the TypeScript `attrNameTable`, which only builds tables for IFC2X3/IFC4/
/// IFC4X3 and returns `null` — skipping this check entirely — for IFC5).
/// IFC4/IFC4X3 targets are supersets of IFC2X3/IFC4 in practice for every
/// type this crate's rename tables know about, so this deliberately answers
/// `false` (representable) for any other target rather than guessing from an
/// incomplete table.
pub(crate) fn has_representation(type_name: &str, to: &str) -> bool {
    if to != "IFC2X3" {
        return true;
    }
    IFC2X3_ENTITY_NAMES.binary_search(&type_name).is_ok()
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
/// A rooted (`IfcRoot`) entity safely becomes an `IFCPROXY` placeholder —
/// the same substitution `should_skip_entity`'s hand-listed alignment types
/// already get, extended here to every other unmapped rooted type. A
/// non-rooted entity (a representation item or resource type referenced
/// POSITIONALLY) cannot take that fallback and returns an error instead of
/// guessing; unlike the TypeScript twin, this crate has not yet ported the
/// narrow `WITHHOLDABLE_UNROOTED_TYPES` omission mechanism (#5114/#5115), so
/// every non-rooted unrepresented type errors here, with no exceptions.
pub(crate) fn resolve_unrepresented_entity(
    prefix: &str,
    entity_type: &str,
    to: &str,
    express_id: u32,
) -> Result<String, UnrepresentedEntityError> {
    if is_rooted_type(entity_type) {
        return Ok(format!(
            "{prefix}IFCPROXY('{}',$,'{}',$,$,$,$,.NOTDEFINED.,$);",
            placeholder_guid(express_id),
            entity_type
        ));
    }
    Err(UnrepresentedEntityError {
        express_id,
        entity_type: entity_type.to_string(),
        to_schema: to.to_string(),
    })
}

/// `schema_convert.rs::convert_record`'s hook into this module: `None` when
/// `new_type` (the type AFTER any rename `map_4_to_2x3` etc. already
/// applied) has a real representation in `to`, so the caller's normal
/// rename/trim/pad logic should continue; `Some` when it does not, in which
/// case the caller must return the wrapped result immediately rather than
/// fall into that logic with a type `to` never declared. `should_skip_entity`
/// (checked first, by the caller) only covers its hand-listed alignment
/// types -- this is the general case (#5116), checked on `new_type` because
/// that is what `has_representation` must agree exists, but resolved
/// (proxy/error) against the ORIGINAL `entity_type`, matching the TypeScript
/// twin's `resolveUnrepresentedEntity(prefix, entityType, ...)`.
pub(crate) fn check_representation(
    prefix: &str, entity_type: &str, new_type: &str, to: &str, express_id: u32,
) -> Option<Result<String, UnrepresentedEntityError>> {
    if has_representation(new_type, to) {
        return None;
    }
    Some(resolve_unrepresented_entity(prefix, entity_type, to, express_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ifc2x3_has_no_triangulated_face_set() {
        assert!(!has_representation("IFCTRIANGULATEDFACESET", "IFC2X3"));
    }

    #[test]
    fn ifc2x3_has_wall() {
        assert!(has_representation("IFCWALL", "IFC2X3"));
    }

    #[test]
    fn non_ifc2x3_targets_are_not_checked() {
        assert!(has_representation("IFCTRIANGULATEDFACESET", "IFC4"));
        assert!(has_representation("IFCTRIANGULATEDFACESET", "IFC4X3"));
        assert!(has_representation("IFCTRIANGULATEDFACESET", "IFC5"));
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
            resolve_unrepresented_entity("#100=", "IFCSTRUCTURALCURVEREACTION", "IFC2X3", 100)
                .unwrap();
        assert!(out.contains("IFCPROXY"));
        assert!(out.contains("'IFCSTRUCTURALCURVEREACTION'"));
    }

    #[test]
    fn non_rooted_unrepresented_type_errors() {
        // A representation item, not an IfcRoot subtype -- proxying it would
        // swap one illegal file for a differently-illegal one.
        let err = resolve_unrepresented_entity("#101=", "IFCCARTESIANPOINTLIST3D", "IFC2X3", 101)
            .unwrap_err();
        assert_eq!(err.express_id, 101);
        assert!(err.to_string().contains("IFCCARTESIANPOINTLIST3D"));
        assert!(err.to_string().contains("IFC2X3"));
    }
}
