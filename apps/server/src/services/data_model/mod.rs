// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Data model extraction service - extracts properties, relationships, and spatial hierarchy.

mod classifications;
mod documents;
mod materials;
mod metadata;
mod properties;
mod quantities;
mod relationships;
mod spatial;
mod types;

pub use types::*;

use classifications::extract_classifications;
use documents::extract_documents;
use ifc_lite_core::{
    build_entity_index, extract_length_unit_scale, DecodedEntity, EntityDecoder, EntityScanner,
};
use materials::extract_materials;
use metadata::extract_entity_metadata;
use properties::extract_properties;
use quantities::extract_quantities;
use relationships::extract_relationships;
use spatial::build_spatial_hierarchy;
use std::sync::Arc;

/// Extract complete data model from IFC content.
pub fn extract_data_model<T>(content: &T) -> DataModel
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    let extract_start = std::time::Instant::now();
    tracing::info!(
        content_size = content.len(),
        "Starting data model extraction"
    );

    // Build entity index (shared across all extractors)
    let entity_index = Arc::new(build_entity_index(content));

    // Scan all entities once
    let mut scanner = EntityScanner::new(content);
    let mut all_entities: Vec<EntityJob> = Vec::new();
    let mut total_entities = 0usize;

    let mut last_id = 0u32;
    let mut last_type = String::new();
    let mut max_id = 0u32;
    let mut last_end = 0usize;
    let content_len = content.len();

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        total_entities += 1;
        last_id = id;
        last_type = type_name.to_string();
        last_end = end;
        if id > max_id {
            max_id = id;
        }
        all_entities.push(EntityJob {
            id,
            type_name: type_name.to_string(),
            start,
            end,
        });
    }

    let remaining_bytes = content_len.saturating_sub(last_end);
    tracing::debug!(
        total_entities = total_entities,
        last_id = last_id,
        max_id = max_id,
        last_type = %last_type,
        last_end = last_end,
        content_len = content_len,
        remaining_bytes = remaining_bytes,
        "Scanned all entities"
    );

    // Debug: log sample entity types to diagnose issues
    if tracing::enabled!(tracing::Level::DEBUG) {
        let sample_types: Vec<&str> = all_entities
            .iter()
            .take(20)
            .map(|j| j.type_name.as_str())
            .collect();
        tracing::debug!(?sample_types, "Sample entity types from scan");

        // Check if any type contains "PROPERTY" or "REL" (case-insensitive)
        let has_property_like = all_entities
            .iter()
            .any(|j| j.type_name.to_uppercase().contains("PROPERTY"));
        let has_rel_like = all_entities
            .iter()
            .any(|j| j.type_name.to_uppercase().starts_with("IFCREL"));
        tracing::debug!(
            has_property_like = has_property_like,
            has_rel_like = has_rel_like,
            "Entity type pattern check"
        );

        // Debug: count property sets and relationships in scanned entities
        let pset_count = all_entities
            .iter()
            .filter(|j| j.type_name.to_uppercase() == "IFCPROPERTYSET")
            .count();
        let rel_count = all_entities
            .iter()
            .filter(|j| {
                let t = j.type_name.to_uppercase();
                t == "IFCRELDEFINESBYPROPERTIES"
                    || t == "IFCRELAGGREGATES"
                    || t == "IFCRELCONTAINEDINSPATIALSTRUCTURE"
            })
            .count();
        tracing::debug!(
            pset_count = pset_count,
            rel_count = rel_count,
            "Entity type counts before extraction"
        );
    }

    // Parallel extraction using rayon::join
    let content_arc = Arc::new(content.to_vec());
    let (entities, ((property_sets, quantity_sets), relationships)) = rayon::join(
        || extract_entity_metadata(&all_entities, &content_arc, &entity_index),
        || {
            rayon::join(
                || {
                    rayon::join(
                        || extract_properties(&all_entities, &content_arc, &entity_index),
                        || extract_quantities(&all_entities, &content_arc, &entity_index),
                    )
                },
                || extract_relationships(&all_entities, &content_arc, &entity_index),
            )
        },
    );

    // Extract length unit scale (e.g., 0.001 for millimeters)
    let mut unit_decoder = EntityDecoder::with_arc_index(content, entity_index.clone());
    let project_id_for_units = entities
        .iter()
        .find(|e| e.type_name.to_uppercase() == "IFCPROJECT")
        .map(|e| e.entity_id)
        .unwrap_or(0);
    let length_unit_scale = if project_id_for_units > 0 {
        extract_length_unit_scale(&mut unit_decoder, project_id_for_units).unwrap_or(1.0)
    } else {
        1.0
    };
    tracing::debug!(
        length_unit_scale = length_unit_scale,
        "Extracted length unit scale"
    );

    // Extract classifications, materials, and documents in parallel. These
    // follow the same `IfcRelAssociates*` pattern as the relationship pass but
    // resolve the referenced object (classification reference, material layer
    // set, document) into a flat, element-keyed shape (issue #900 parity).
    // Materials need the length-unit scale to report layer thickness in metres.
    let ((classifications, materials), documents) = rayon::join(
        || {
            rayon::join(
                || extract_classifications(&all_entities, &content_arc, &entity_index),
                || {
                    extract_materials(
                        &all_entities,
                        &content_arc,
                        &entity_index,
                        length_unit_scale,
                    )
                },
            )
        },
        || extract_documents(&all_entities, &content_arc, &entity_index),
    );

    // Build spatial hierarchy (depends on relationships and entities)
    let spatial_hierarchy = build_spatial_hierarchy(
        &relationships,
        &entities,
        content,
        &entity_index,
        length_unit_scale,
    );

    let extract_time = extract_start.elapsed();
    tracing::info!(
        entities = entities.len(),
        property_sets = property_sets.len(),
        quantity_sets = quantity_sets.len(),
        relationships = relationships.len(),
        classifications = classifications.len(),
        materials = materials.len(),
        documents = documents.len(),
        spatial_nodes = spatial_hierarchy.nodes.len(),
        extract_time_ms = extract_time.as_millis(),
        "Data model extraction complete"
    );

    DataModel {
        entities,
        property_sets,
        quantity_sets,
        relationships,
        classifications,
        materials,
        documents,
        spatial_hierarchy,
    }
}

/// Read an `IfcLogical` / `IfcBoolean` attribute as a tri-state `Option<bool>`
/// (`.U.` / absent → `None`).
pub(super) fn read_logical(entity: &DecodedEntity, index: usize) -> Option<bool> {
    let token = entity.get(index)?.as_enum()?;
    match token {
        "T" | "TRUE" | "true" => Some(true),
        "F" | "FALSE" | "false" => Some(false),
        _ => None,
    }
}

/// Collect the `RelatedObjects` (attribute 4) entity ids of an `IfcRelAssociates*`.
pub(super) fn related_object_ids(rel: &DecodedEntity) -> Vec<u32> {
    rel.get_list(4)
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IFC4 model (millimetre units) with a wall carrying a two-layer material
    /// set, a Uniclass classification reference, and a document reference — one
    /// of each association type (issue #900).
    const ASSOCIATIONS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-900 associations fixture'),'2;1');
FILE_NAME('assoc.ifc','2026-06-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
/* Material layer set: 200mm Concrete + 50mm ventilated Insulation */
#30=IFCMATERIAL('Concrete',$,$);
#31=IFCMATERIAL('Insulation',$,$);
#32=IFCMATERIALLAYER(#30,200.,.F.,'Core',$,$,$);
#33=IFCMATERIALLAYER(#31,50.,.T.,'Insul',$,$,$);
#34=IFCMATERIALLAYERSET((#32,#33),'WallSet',$);
#35=IFCRELASSOCIATESMATERIAL('Mat0000000000000000001',$,$,$,(#28),#34);
/* Classification */
#40=IFCCLASSIFICATION('Uniclass 2015','2',$,'Uniclass 2015',$,$,$);
#41=IFCCLASSIFICATIONREFERENCE('https://uniclass.example','EF_25_10_25','Walls',#40,$,$);
#42=IFCRELASSOCIATESCLASSIFICATION('Cls0000000000000000001',$,$,$,(#28),#41);
/* Document */
#50=IFCDOCUMENTREFERENCE('https://docs.example/spec','DOC-001','Wall spec',$,$);
#51=IFCRELASSOCIATESDOCUMENT('Doc0000000000000000001',$,$,$,(#28),#50);
/* Column with a material constituent set */
#60=IFCCOLUMN('Col0000000000000000001',$,'C1',$,$,$,$,$,$);
#61=IFCMATERIAL('Steel',$,$);
#62=IFCMATERIALCONSTITUENT('Core',$,#61,$,'load-bearing');
#63=IFCMATERIALCONSTITUENTSET('ColSet',$,(#62));
#64=IFCRELASSOCIATESMATERIAL('Mat0000000000000000002',$,$,$,(#60),#63);
/* Beam with a material profile set */
#70=IFCBEAM('Bem0000000000000000001',$,'B1',$,$,$,$,$,$);
#71=IFCMATERIAL('Timber',$,$);
#72=IFCMATERIALPROFILE('Flange',$,#71,$,$,$);
#73=IFCMATERIALPROFILESET('BeamSet',$,(#72),$);
#74=IFCRELASSOCIATESMATERIAL('Mat0000000000000000003',$,$,$,(#70),#73);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn extracts_classification_material_and_document_associations() {
        let dm = extract_data_model(ASSOCIATIONS_IFC);

        // Classification: one reference assigned to the wall (#28).
        assert_eq!(dm.classifications.len(), 1, "expected one classification");
        let c = &dm.classifications[0];
        assert_eq!(c.element_id, 28);
        assert_eq!(c.system_name.as_deref(), Some("Uniclass 2015"));
        assert_eq!(c.identification.as_deref(), Some("EF_25_10_25"));
        assert_eq!(c.name.as_deref(), Some("Walls"));

        // Materials: the wall (#28) has two layers, thickness in metres (mm * 0.001).
        let mut layers: Vec<_> = dm
            .materials
            .iter()
            .filter(|m| m.element_id == 28)
            .cloned()
            .collect();
        layers.sort_by_key(|m| m.layer_index);
        assert_eq!(layers.len(), 2, "expected two wall layers");
        assert_eq!(layers[0].element_id, 28);
        assert_eq!(layers[0].set_name.as_deref(), Some("WallSet"));
        assert_eq!(layers[0].material_name, "Concrete");
        assert!(
            (layers[0].thickness.unwrap() - 0.2).abs() < 1e-9,
            "200mm -> 0.2m"
        );
        assert_eq!(layers[0].is_ventilated, Some(false));
        assert_eq!(layers[1].material_name, "Insulation");
        assert!(
            (layers[1].thickness.unwrap() - 0.05).abs() < 1e-9,
            "50mm -> 0.05m"
        );
        assert_eq!(layers[1].is_ventilated, Some(true));

        // Document.
        assert_eq!(dm.documents.len(), 1, "expected one document");
        let d = &dm.documents[0];
        assert_eq!(d.element_id, 28);
        assert_eq!(d.identification.as_deref(), Some("DOC-001"));
        assert_eq!(d.name.as_deref(), Some("Wall spec"));
        assert_eq!(d.location.as_deref(), Some("https://docs.example/spec"));

        // Material constituent set on the column (#60) — constituents read from
        // attribute 2, set name preserved from attribute 0.
        let column_mats: Vec<_> = dm.materials.iter().filter(|m| m.element_id == 60).collect();
        assert_eq!(
            column_mats.len(),
            1,
            "expected one constituent for the column"
        );
        assert_eq!(column_mats[0].material_name, "Steel");
        assert_eq!(column_mats[0].set_name.as_deref(), Some("ColSet"));

        // The IfcRelAssociates* family must also land in the generic relationship
        // graph (relating = the material/classification/document, related = element).
        let has_rel = |ty: &str, relating: u32, related: u32| {
            dm.relationships.iter().any(|r| {
                r.rel_type.eq_ignore_ascii_case(ty)
                    && r.relating_id == relating
                    && r.related_id == related
            })
        };
        assert!(
            has_rel("IFCRELASSOCIATESCLASSIFICATION", 41, 28),
            "classification association missing from relationships"
        );
        assert!(
            has_rel("IFCRELASSOCIATESDOCUMENT", 50, 28),
            "document association missing from relationships"
        );
        assert!(
            has_rel("IFCRELASSOCIATESMATERIAL", 34, 28),
            "material association missing from relationships"
        );

        // Material profile set on the beam (#70).
        let beam_mats: Vec<_> = dm.materials.iter().filter(|m| m.element_id == 70).collect();
        assert_eq!(beam_mats.len(), 1, "expected one profile for the beam");
        assert_eq!(beam_mats[0].material_name, "Timber");
        assert_eq!(beam_mats[0].set_name.as_deref(), Some("BeamSet"));
    }

    /// IFC4 model exercising TYPE-level parity (issue #1751): an IfcWallType
    /// whose HasPropertySets carries a pset (string / boolean / real / integer)
    /// and a Qto, two walls bound via IfcRelDefinesByType, and one instance pset.
    const TYPE_PARITY_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#100=IFCWALL('Wall00000000000000001A',$,'W-A',$,$,$,$,$,$);
#110=IFCWALL('Wall00000000000000001B',$,'W-B',$,$,$,$,$,$);
#200=IFCWALLTYPE('Type00000000000000001A',$,'WT-Std',$,$,(#210,#220),$,$,$,.STANDARD.);
#210=IFCPROPERTYSET('Pset00000000000000001A',$,'Pset_WallCommon',$,(#211,#212,#213,#214));
#211=IFCPROPERTYSINGLEVALUE('Manufacturer',$,IFCLABEL('ACME'),$);
#212=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#213=IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,IFCREAL(0.24),$);
#214=IFCPROPERTYSINGLEVALUE('Layers',$,IFCINTEGER(3),$);
#220=IFCELEMENTQUANTITY('Qset00000000000000001A',$,'Qto_WallBaseQuantities',$,$,(#221));
#221=IFCQUANTITYLENGTH('Width',$,$,200.);
#230=IFCRELDEFINESBYTYPE('Rdbt00000000000000001A',$,$,$,(#100,#110),#200);
#250=IFCPROPERTYSET('Pset00000000000000002A',$,'Pset_WallCommon',$,(#251));
#251=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 120'),$);
#260=IFCRELDEFINESBYPROPERTIES('Rdbp00000000000000001A',$,$,$,(#100),#250);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn extracts_type_relationship_and_resolves_typed_property_values() {
        let dm = extract_data_model(TYPE_PARITY_IFC);

        // IfcRelDefinesByType survives (was dropped by the `_ => (4,5)` default):
        // relating = type #200, related = each wall.
        let dbt = |related: u32| {
            dm.relationships.iter().any(|r| {
                r.rel_type.eq_ignore_ascii_case("IFCRELDEFINESBYTYPE")
                    && r.relating_id == 200
                    && r.related_id == related
            })
        };
        assert!(dbt(100), "DefinesByType #200->#100 missing");
        assert!(dbt(110), "DefinesByType #200->#110 missing");

        // Type HasPropertySets are attached to the type via synthetic edges
        // (relating = set, related = type).
        let type_link = |set: u32| {
            dm.relationships.iter().any(|r| {
                r.rel_type == "TYPEHASPROPERTYSETS" && r.relating_id == set && r.related_id == 200
            })
        };
        assert!(type_link(210), "TYPEHASPROPERTYSETS #210->#200 missing");
        assert!(type_link(220), "TYPEHASPROPERTYSETS #220->#200 missing (qset)");

        // Typed property values resolve to canonical strings + kinds + data_type
        // (no more Debug garbage / "unknown").
        let pset = dm
            .property_sets
            .iter()
            .find(|p| p.pset_id == 210)
            .expect("type pset #210 extracted");
        let prop = |name: &str| pset.properties.iter().find(|p| p.property_name == name).unwrap();

        let m = prop("Manufacturer");
        assert_eq!(m.property_value, "ACME");
        assert_eq!(m.property_type, "string");
        assert_eq!(m.data_type.as_deref(), Some("IFCLABEL"));

        let ext = prop("IsExternal");
        assert_eq!(ext.property_value, "true");
        assert_eq!(ext.property_type, "boolean");
        assert_eq!(ext.data_type.as_deref(), Some("IFCBOOLEAN"));

        let u = prop("ThermalTransmittance");
        assert_eq!(u.property_value, "0.24");
        assert_eq!(u.property_type, "real");
        assert_eq!(u.data_type.as_deref(), Some("IFCREAL"));

        let c = prop("Layers");
        assert_eq!(c.property_value, "3");
        assert_eq!(c.property_type, "integer");
        assert_eq!(c.data_type.as_deref(), Some("IFCINTEGER"));

        // Instance pset value also resolves (same code path).
        let inst = dm.property_sets.iter().find(|p| p.pset_id == 250).unwrap();
        let fr = &inst.properties[0];
        assert_eq!(fr.property_name, "FireRating");
        assert_eq!(fr.property_value, "REI 120");
        assert_eq!(fr.property_type, "string");
    }

    #[test]
    fn associations_empty_without_relationships() {
        let plain = r#"ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
#28=IFCWALL('Wall00000000000000001',$,'W1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;
        let dm = extract_data_model(plain);
        assert!(dm.classifications.is_empty());
        assert!(dm.materials.is_empty());
        assert!(dm.documents.is_empty());
    }
}
