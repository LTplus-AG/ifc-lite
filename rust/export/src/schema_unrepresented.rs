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

/// IFC2X3 resources handled by the full writer's omission pass (#10970).
/// Sorted for binary search. The shared routes fixture checks both twins.
pub(crate) const OMIT_ON_UPGRADE: &[&str] = &[
  "IFC2DCOMPOSITECURVE", "IFCANGULARDIMENSION", "IFCANNOTATIONCURVEOCCURRENCE",
  "IFCANNOTATIONFILLAREAOCCURRENCE", "IFCANNOTATIONOCCURRENCE", "IFCANNOTATIONSURFACE",
  "IFCANNOTATIONSURFACEOCCURRENCE", "IFCANNOTATIONSYMBOLOCCURRENCE", "IFCANNOTATIONTEXTOCCURRENCE",
  "IFCAPPLIEDVALUERELATIONSHIP", "IFCAPPROVALACTORRELATIONSHIP", "IFCAPPROVALPROPERTYRELATIONSHIP",
  "IFCBEZIERCURVE", "IFCCLASSIFICATIONITEM", "IFCCLASSIFICATIONITEMRELATIONSHIP",
  "IFCCLASSIFICATIONNOTATION", "IFCCLASSIFICATIONNOTATIONFACET", "IFCCONNECTIONPORTGEOMETRY",
  "IFCCONSTRAINTAGGREGATIONRELATIONSHIP", "IFCCONSTRAINTCLASSIFICATIONRELATIONSHIP",
  "IFCCONSTRAINTRELATIONSHIP", "IFCCRANERAILASHAPEPROFILEDEF", "IFCCRANERAILFSHAPEPROFILEDEF",
  "IFCDEFINEDSYMBOL", "IFCDIAMETERDIMENSION", "IFCDIMENSIONCALLOUTRELATIONSHIP", "IFCDIMENSIONCURVE",
  "IFCDIMENSIONCURVEDIRECTEDCALLOUT", "IFCDIMENSIONCURVETERMINATOR", "IFCDIMENSIONPAIR",
  "IFCDOCUMENTELECTRONICFORMAT", "IFCDRAUGHTINGCALLOUT", "IFCDRAUGHTINGCALLOUTRELATIONSHIP",
  "IFCDRAUGHTINGPREDEFINEDTEXTFONT", "IFCENVIRONMENTALIMPACTVALUE", "IFCEXTERNALLYDEFINEDSYMBOL",
  "IFCFILLAREASTYLETILESYMBOLWITHSTYLE", "IFCLINEARDIMENSION", "IFCONEDIRECTIONREPEATFACTOR",
  "IFCPREDEFINEDDIMENSIONSYMBOL", "IFCPREDEFINEDPOINTMARKERSYMBOL", "IFCPREDEFINEDSYMBOL",
  "IFCPREDEFINEDTERMINATORSYMBOL", "IFCPROJECTIONCURVE", "IFCPROPERTYCONSTRAINTRELATIONSHIP",
  "IFCRADIUSDIMENSION", "IFCRATIONALBEZIERCURVE", "IFCREFERENCESVALUEDOCUMENT", "IFCRELAXATION",
  "IFCSTRUCTUREDDIMENSIONCALLOUT", "IFCSYMBOLSTYLE", "IFCTERMINATORSYMBOL",
  "IFCTEXTSTYLEWITHBOXCHARACTERISTICS", "IFCTIMESERIESREFERENCERELATIONSHIP",
  "IFCTWODIRECTIONREPEATFACTOR", "IFCVERTEXBASEDTEXTUREMAP",
];

/// Dates still written as they are pending date conversion (#10879).
pub(crate) const VERBATIM_UPGRADE: &[&str] = &[
    "IFCCALENDARDATE", "IFCCOORDINATEDUNIVERSALTIMEOFFSET", "IFCDATEANDTIME", "IFCLOCALTIME",
];

/// What a record of `entity_type`, written as `new_type`, becomes in `to`.
/// Twin of the TypeScript `missingTypeRoute`, pinned for both by
/// `tests/fixtures/schema_unrepresented_vectors.json` (#7742, #10902).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// The target declares the type, has no registry (IFC5), or the source
    /// does not know the name either: written.
    Written,
    /// A proxy if rooted, refused if not ([`resolve_unrepresented_entity`]).
    /// `plan_and_route` also gives it to an IFC4X3 alignment product, which
    /// [`product_proxy`] writes as a proxy keeping attributes 1-6.
    Unrepresented,
    /// Converted by another pass, so the warnings do not name it here: an
    /// IFC2X3 varying action on an IFC4 target by the structural pass, which
    /// reports it (#9668), and an `IfcPresentationStyleAssignment` on an
    /// IFC4X3 target by style flattening (D57).
    Handled,
    /// Withheld by the whole-file reference pass (#10970).
    Omitted,
    /// A type the source declares and the target does not, written as it is
    /// and named in the warnings: [`VERBATIM_UPGRADE`], or any type on an
    /// IFC4X3 target, which is not checked yet (#10971).
    Verbatim,
}

/// The [`Route`] for `new_type` in `to`. `declared_in_source`: the source
/// registry declares `entity_type`.
/// - An IFC2X3 target refuses or proxies a type it lacks, for every source,
///   even a name no registry knows (`#1=IFCLABEL('x');`, #7683).
/// - An IFC4 target does so for a type an IFC4X3 source declares (#7742) and
///   one an IFC2X3 source declares, but not one on [`VERBATIM_UPGRADE`] (#10902).
pub(crate) fn missing_type_route(entity_type: &str, new_type: &str, from: &str, to: &str, declared_in_source: bool) -> Route {
    if !matches!(to, "IFC2X3" | "IFC4" | "IFC4X3") || schema_attribute_names(to, new_type).is_some() {
        return Route::Written;
    }
    match (from, to) {
        (_, "IFC2X3") => Route::Unrepresented,
        _ if !declared_in_source => Route::Written,
        // The structural pass converts and reports IFC2X3 <-> IFC4 only.
        ("IFC2X3", "IFC4") if crate::schema_structural_varying::StructuralVarying::is_varying(entity_type) => Route::Handled,
        _ if entity_type == crate::schema_style_flatten::ASSIGNMENT && crate::schema_style_flatten::StyleFlatten::applies(from, to) => Route::Handled,
        ("IFC4X3", "IFC4") => Route::Unrepresented,
        ("IFC2X3", "IFC4") if OMIT_ON_UPGRADE.binary_search(&entity_type).is_ok() => Route::Omitted,
        ("IFC2X3", "IFC4") if !VERBATIM_UPGRADE.contains(&entity_type) => Route::Unrepresented,
        _ => Route::Verbatim,
    }
}

/// How the warnings name the records of a type with no type of the target's own (#10902).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Named {
    Proxied,
    Verbatim,
}

impl Route {
    /// How the warnings name a record of `entity_type` on this route; a written
    /// or refused one, or one another pass handles ([`Route::Handled`]), is not named here.
    pub(crate) fn named(self, entity_type: &str) -> Option<Named> {
        match self {
            Route::Unrepresented if is_rooted_type(entity_type) => Some(Named::Proxied),
            Route::Verbatim => Some(Named::Verbatim),
            _ => None,
        }
    }
}

/// The warnings for `(type, how named, records)`, a type possibly given once per schema pair.
pub(crate) fn missing_type_warnings<'a>(counts: impl IntoIterator<Item = (&'a str, Named, usize)>) -> Vec<String> {
    let mut by_named: [std::collections::BTreeMap<&str, usize>; 2] = Default::default();
    for (ty, named, records) in counts {
        *by_named[named as usize].entry(ty).or_default() += records;
    }
    let line = |by_type: &std::collections::BTreeMap<&str, usize>, what: &str| {
        let n: usize = by_type.values().sum();
        let types: Vec<String> = by_type.iter().map(|(t, k)| format!("{t} ({k})")).collect();
        (n > 0).then(|| format!("{n} record(s) of a type the target schema does not declare {what}: {}.", types.join(", ")))
    };
    let [proxied, verbatim] = &by_named;
    line(proxied, "were written as IFCPROXY").into_iter().chain(line(verbatim, "were written as they are, which readers may reject")).collect()
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
    pub(crate) reason: Option<&'static str>,
}

impl std::fmt::Display for UnrepresentedEntityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(reason) = self.reason {
            return write!(f, "Cannot convert #{} ({}) to {}: {reason}", self.express_id, self.entity_type, self.to_schema);
        }
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
        reason: None,
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
#[path = "schema_unrepresented_tests.rs"]
mod tests;
