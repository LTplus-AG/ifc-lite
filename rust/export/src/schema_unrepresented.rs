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

use std::borrow::Cow;

use crate::rooted_type::is_rooted_type;
use crate::schema_convert::{placeholder_guid, schema_attribute_names};

/// IFC2X3-only types an IFC2X3 -> IFC4 upgrade writes as they are, under a
/// name IFC4 does not declare, named in the export warnings. The non-rooted
/// ones (D59) cannot become `IFCPROXY` (an `IfcProduct`), and leaving one out
/// would leave its referrers pointing at nothing; refusing them failed real
/// files that export on main. Twin of the TypeScript `VERBATIM_UPGRADE`, both
/// pinned by `tests/fixtures/schema_unrepresented_vectors.json` (`routes`). An
/// IFC2X3-only type NOT listed (and not a varying action, [`Route::Structural`])
/// is proxied if rooted and refused if not.
pub(crate) const VERBATIM_UPGRADE: &[&str] = &[
    // Dates: converted to IFC4 date strings by #10879.
    "IFCCALENDARDATE", "IFCCOORDINATEDUNIVERSALTIMEOFFSET", "IFCDATEANDTIME", "IFCLOCALTIME",
    // Everything else: left out with its references cleared, or mapped (#10970).
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
    "IFCDRAUGHTINGPREDEFINEDTEXTFONT", "IFCENVIRONMENTALIMPACTVALUE", "IFCEXTENDEDMATERIALPROPERTIES",
    "IFCEXTERNALLYDEFINEDSYMBOL", "IFCFILLAREASTYLETILESYMBOLWITHSTYLE", "IFCFUELPROPERTIES",
    "IFCGENERALMATERIALPROPERTIES", "IFCGENERALPROFILEPROPERTIES", "IFCHYGROSCOPICMATERIALPROPERTIES",
    "IFCLINEARDIMENSION", "IFCMECHANICALCONCRETEMATERIALPROPERTIES", "IFCMECHANICALMATERIALPROPERTIES",
    "IFCMECHANICALSTEELMATERIALPROPERTIES", "IFCONEDIRECTIONREPEATFACTOR", "IFCOPTICALMATERIALPROPERTIES",
    "IFCPREDEFINEDDIMENSIONSYMBOL", "IFCPREDEFINEDPOINTMARKERSYMBOL", "IFCPREDEFINEDSYMBOL",
    "IFCPREDEFINEDTERMINATORSYMBOL", "IFCPRODUCTSOFCOMBUSTIONPROPERTIES", "IFCPROJECTIONCURVE",
    "IFCPROPERTYCONSTRAINTRELATIONSHIP", "IFCRADIUSDIMENSION", "IFCRATIONALBEZIERCURVE",
    "IFCREFERENCESVALUEDOCUMENT", "IFCRELAXATION", "IFCRIBPLATEPROFILEPROPERTIES",
    "IFCSTRUCTURALPROFILEPROPERTIES", "IFCSTRUCTURALSTEELPROFILEPROPERTIES", "IFCSTRUCTUREDDIMENSIONCALLOUT",
    "IFCSYMBOLSTYLE", "IFCTERMINATORSYMBOL", "IFCTEXTSTYLEWITHBOXCHARACTERISTICS",
    "IFCTHERMALMATERIALPROPERTIES", "IFCTIMESERIESREFERENCERELATIONSHIP", "IFCTWODIRECTIONREPEATFACTOR",
    "IFCVERTEXBASEDTEXTUREMAP", "IFCWATERPROPERTIES",
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
    Unrepresented,
    /// An IFC2X3 varying action: written as it is and named by the
    /// structural pass (#9668).
    Structural,
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
        ("IFC2X3", _) if crate::schema_structural_varying::StructuralVarying::is_varying(entity_type) => Route::Structural,
        ("IFC4X3", "IFC4") => Route::Unrepresented,
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
    /// or refused one, or a varying action, is not named here.
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
/// it keeps none of its attributes: an `IfcRoot` is not necessarily an
/// `IfcProduct`, so its slots 5 and 6 need not be a placement and a
/// representation. A
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
        if slot(i).trim() == "$" { Cow::Owned(format!("'{entity_type}'")) } else { Cow::Borrowed(slot(i)) }
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

    fn route(ty: &str, from: &str, to: &str, declared: bool) -> Route {
        missing_type_route(ty, ty, from, to, declared)
    }

    #[test]
    fn ifc2x3_has_no_triangulated_face_set() {
        assert_eq!(route("IFCTRIANGULATEDFACESET", "IFC4", "IFC2X3", true), Route::Unrepresented);
    }

    #[test]
    fn ifc2x3_has_wall() {
        assert_eq!(route("IFCWALL", "IFC4", "IFC2X3", true), Route::Written);
    }

    #[test]
    fn an_ifc4_target_checks_what_an_ifc4x3_or_ifc2x3_source_declares_7742_10902() {
        assert_eq!(route("IFCCURVESEGMENT", "IFC4X3", "IFC4", true), Route::Unrepresented);
        // An IFC4X3 target is not checked yet (#10971).
        assert_eq!(route("IFCPRESENTATIONSTYLEASSIGNMENT", "IFC2X3", "IFC4X3", true), Route::Verbatim);
        // A name the source does not declare is not judged.
        assert_eq!(route("IFCCURVESEGMENT", "IFC4X3", "IFC4", false), Route::Written);
        assert_eq!(route("IFCTRIANGULATEDFACESET", "IFC4X3", "IFC4", true), Route::Written);
        // IFC2X3-only: rooted is proxied, a listed one is kept (D59, #10902), a varying action is the structural pass's (#9668).
        assert_eq!(route("IFCRELOCCUPIESSPACES", "IFC2X3", "IFC4", true), Route::Unrepresented);
        assert_eq!(route("IFCCALENDARDATE", "IFC2X3", "IFC4", true), Route::Verbatim);
        assert_eq!(route("IFCSTRUCTURALLINEARACTIONVARYING", "IFC2X3", "IFC4", true), Route::Structural);
        // IFC5 has no registry.
        assert_eq!(route("IFCTRIANGULATEDFACESET", "IFC4", "IFC5", true), Route::Written);
    }

    /// The registry check (#10902), as the TypeScript `schema-representation-registry.test.ts`:
    /// every type a source declares and the target lacks, by its route, is the
    /// fixture's `routes` partition, so a new source-only type or a fixed gap
    /// fails until the fixture says so. Core exposes only the IFC4X3 catalog, so
    /// the candidates are it plus every listed name; the TypeScript twin walks
    /// each schema's own table and so proves the lists complete.
    #[test]
    fn every_source_only_type_has_a_route_10902() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../tests/fixtures/schema_unrepresented_vectors.json")).unwrap();
        let listed = |pair: &str, key: &str| -> Vec<String> {
            let mut v: Vec<String> = fixture["routes"][pair][key].as_array().map_or_else(Vec::new, |a| a.iter().map(|s| s.as_str().unwrap().to_owned()).collect());
            v.sort();
            v
        };
        let mut candidates: std::collections::BTreeSet<String> = ifc_lite_core::IFC_TYPES.iter().map(|t| t.name().to_ascii_uppercase()).collect();
        for routes in fixture["routes"].as_object().unwrap().values() {
            for list in routes.as_object().unwrap().values() {
                candidates.extend(list.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()));
            }
        }
        let schemas = ["IFC2X3", "IFC4", "IFC4X3"];
        for from in schemas {
            for to in schemas.into_iter().filter(|to| *to != from) {
                let (mut verbatim, mut proxied, mut structural) = (Vec::new(), Vec::new(), Vec::new());
                for name in candidates.iter().cloned() {
                    if schema_attribute_names(from, &name).is_none() { continue; }
                    let new_type = crate::schema_convert::convert_entity_type(&name, from, to);
                    if crate::schema_convert::should_skip_entity(&new_type, to) { continue; }
                    match missing_type_route(&name, &new_type, from, to, true) {
                        Route::Verbatim => verbatim.push(name),
                        Route::Structural => structural.push(name),
                        Route::Unrepresented if is_rooted_type(&name) => proxied.push(name),
                        _ => {}
                    }
                }
                verbatim.sort();
                proxied.sort();
                structural.sort();
                let pair = format!("{from}>{to}");
                assert_eq!(verbatim, listed(&pair, "verbatim"), "{pair}: written verbatim");
                assert_eq!(structural, listed(&pair, "structural"), "{pair}: the structural pass's");
                if pair == "IFC2X3>IFC4" {
                    assert_eq!(proxied, listed(&pair, "proxied"), "{pair}: proxied");
                    let mut ours: Vec<String> = VERBATIM_UPGRADE.iter().map(|s| (*s).to_owned()).collect();
                    ours.sort();
                    assert_eq!(ours, verbatim, "VERBATIM_UPGRADE is the fixture's list");
                }
            }
        }
    }

    /// As the TypeScript twin's end-to-end case: an IFC2X3 -> IFC4 upgrade
    /// maps, proxies or keeps each record, and the warnings name the last two.
    #[test]
    fn an_upgrade_writes_each_route_and_names_it_10902() {
        let data = "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);\n#2=IFCSPACE('0AvctVUKr0kugbFTf53O9L',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);\n#3=IFCACTOR('0BvctVUKr0kugbFTf53O9L',$,'Tenant',$,$,$);\n#4=IFCRELOCCUPIESSPACES('0CvctVUKr0kugbFTf53O9L',$,$,$,(#2),$,#3,$);\n#5=IFCMOVE('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1','planned',$,.F.,1,$,$,('pack'));\n#6=IFCCALENDARDATE(1,2,2020);";
        let src = format!("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n{data}\nENDSEC;\nEND-ISO-10303-21;\n");
        let opts = crate::step::StepOptions { schema: Some("IFC4".into()), ..Default::default() };
        let (out, _, warnings) = crate::step::export_step_with_diagnostics(src.as_bytes(), &opts).unwrap();
        let line = |id: &str| out.lines().find(|l| l.starts_with(id)).unwrap_or_default().to_owned();
        assert!(line("#4=").starts_with("#4=IFCPROXY(") && line("#4=").ends_with(",$,'IFCRELOCCUPIESSPACES',$,$,$,$,.NOTDEFINED.,$);"), "{out}");
        assert_eq!(line("#5="), "#5=IFCTASK('0DvctVUKr0kugbFTf53O9L',$,'Move',$,$,'T-1',$,'planned',$,.F.,1,$,$);");
        assert_eq!(line("#6="), "#6=IFCCALENDARDATE(1,2,2020);");
        let named = warnings.join("\n");
        assert!(named.contains("were written as IFCPROXY: IFCRELOCCUPIESSPACES (1)."), "{named}");
        assert!(named.contains("which readers may reject: IFCCALENDARDATE (1)."), "{named}");
    }

    #[test]
    fn the_warnings_name_each_type_by_route_10902() {
        let mut plans = crate::schema_plan::PlanCache::default();
        for ty in ["IFCRELOCCUPIESSPACES", "IFCRELOCCUPIESSPACES", "IFCCALENDARDATE", "IFCWALL", "IFCSTRUCTURALLINEARACTIONVARYING"] {
            plans.get(ty, "IFC2X3", "IFC4");
        }
        plans.get("IFCCURVESEGMENT", "IFC4X3", "IFC4");
        // Not the refused IfcCurveSegment, nor the varying action the structural pass names (#9668).
        assert_eq!(plans.warnings(), [
            "2 record(s) of a type the target schema does not declare were written as IFCPROXY: IFCRELOCCUPIESSPACES (2).",
            "1 record(s) of a type the target schema does not declare were written as they are, which readers may reject: IFCCALENDARDATE (1).",
        ]);
    }

    #[test]
    fn rooted_unrepresented_type_becomes_a_proxy() {
        // IfcStructuralCurveReaction is an IfcProduct (rooted): IFC2X3 never
        // defined a curve/surface reaction type at all (only
        // IfcStructuralPointReaction), so this is a genuine "no
        // representation" case, not a rename gap. IFCTRIANGULATEDFACESET
        // (used above for `missing_type_route`) is NOT a valid example here
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
