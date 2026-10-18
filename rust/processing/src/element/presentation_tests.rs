// SPDX-License-Identifier: MPL-2.0
//! Late presentation regressions through the canonical geometry producers.
//! The inline STEP models state invariants; they are not exporter evidence.
use super::session_tests::{job, metadata, options, SOURCE};
use super::*;
use ifc_lite_core::{EntityIndex, IfcSchema};
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::sync::Arc;

const RED: [f32; 4] = [0.9, 0.1, 0.2, 1.];
const GLASS: [f32; 4] = [0.1, 0.8, 0.6, 0.3];

fn produce(
    source: &str,
    id: u32,
    data: OwnedMeshProductionData,
    types: bool,
) -> ProducedElementMeshes {
    let mut decoder = EntityDecoder::new(source);
    let mut router = GeometryRouter::with_units(source, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    router.set_rtc_offset((8., 16., 0.));
    let entity = decoder.decode_by_id(id).unwrap();
    let meta = metadata(id);
    let mut input = job(&entity, &meta);
    if types {
        input.kind = ElementJobKind::TypeProduct {
            rep_maps: vec![(61, 1)],
        };
    }
    let context = ProductionModel::new().snapshot(data);
    let actual =
        produce_element_meshes_owned(&input, &context, &options(), &mut decoder, &router).unwrap();
    let borrowed = produce_element_meshes(
        &input,
        &context.borrowed(),
        &options(),
        &mut decoder,
        &router,
    );
    super::session_tests::assert_same(&actual, &borrowed);
    actual
}

#[test]
fn presentation_direct_style_precedes_materials_on_real_extrusion_without_changing_hash_or_frames()
{
    let plain = produce(SOURCE, 10, OwnedMeshProductionData::default(), false);
    let mut style = GeometryStyleInfo::from_color(RED);
    style.material_name = Some("Authored finish".into());
    let colored = produce(
        SOURCE,
        10,
        OwnedMeshProductionData {
            geometry_style_index: Arc::new([(13, style)].into_iter().collect()),
            element_material_colors: Arc::new([(10, vec![GLASS])].into_iter().collect()),
            ..Default::default()
        },
        false,
    );
    assert_eq!(colored.meshes[0].color, RED);
    assert_eq!(
        colored.meshes[0].material_name.as_deref(),
        Some("Authored finish")
    );
    assert_eq!(colored.meshes[0].geometry_item_id, Some(13));
    assert_eq!(colored.meshes[0].material_id, None);
    assert_eq!(colored.meshes[0].positions, plain.meshes[0].positions);
    assert_eq!(colored.meshes[0].indices, plain.meshes[0].indices);
    assert_eq!(colored.meshes[0].normals, plain.meshes[0].normals);
    assert_eq!(colored.geometry_hash, plain.geometry_hash);
    assert_eq!(colored.geometry_closure, plain.geometry_closure);
    assert_eq!(colored.geometry_volume, plain.geometry_volume);
    assert_eq!(colored.meshes[0].origin, plain.meshes[0].origin);
    assert_eq!(colored.meshes[0].properties, plain.meshes[0].properties);
}

#[test]
fn presentation_one_material_cursor_crosses_real_instance_only_and_materialized_parts() {
    let original = include_str!("../../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    for items in ["#32,#600,#39,#601", "#600,#32,#601,#39"] {
        let source = original.replace("MappedRepresentation',(#32)", &format!("MappedRepresentation',({items})"))
            .replace("ENDSEC;\nEND-ISO", "#600=IFCEXTRUDEDAREASOLID(#8,#11,#9,2.);\n#601=IFCEXTRUDEDAREASOLID(#8,#11,#9,3.);\nENDSEC;\nEND-ISO");
        let mut decoder = EntityDecoder::new(&source);
        let mut router = GeometryRouter::with_units(&source, &mut decoder);
        decoder.seed_unit_scales(router.unit_scale(), 1.);
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        router.enable_output_instancing(Arc::new([(16, (16, 25))].into_iter().collect()));
        router.set_instancing_batch_local(true);
        let context = ProductionModel::new().snapshot(OwnedMeshProductionData {
            element_material_colors: Arc::new([(38, vec![RED, GLASS])].into_iter().collect()),
            ..Default::default()
        });
        let first = decoder.decode_by_id(31).unwrap();
        let template = produce_element_meshes_owned(
            &job(&first, &metadata(31)),
            &context,
            &options(),
            &mut decoder,
            &router,
        )
        .unwrap();
        assert_eq!(
            template.meshes.len(),
            1,
            "first occurrence actually materializes its template"
        );
        let second = decoder.decode_by_id(38).unwrap();
        let result = produce_element_meshes_owned(
            &job(&second, &metadata(38)),
            &context,
            &options(),
            &mut decoder,
            &router,
        )
        .unwrap();
        assert_eq!(result.meshes.len(), 2);
        assert_eq!(result.instance_occurrences.len(), 2);
        let (body, instance) = if items.starts_with("#32") {
            (GLASS, RED)
        } else {
            (RED, GLASS)
        };
        assert!(result.meshes.iter().all(|mesh| mesh.color == body));
        assert!(result
            .instance_occurrences
            .iter()
            .all(|occurrence| occurrence.color == instance));
        assert_eq!(
            result
                .meshes
                .iter()
                .map(|mesh| mesh.geometry_item_id)
                .collect::<Vec<_>>(),
            [Some(600), Some(601)]
        );
        for occurrence in &result.instance_occurrences {
            assert_eq!(occurrence.geometry_item_id, Some(12));
            assert_eq!(occurrence.world_transform[3], 3.);
            assert_eq!(occurrence.world_transform[7], 2.);
            assert_eq!(occurrence.name.as_deref(), Some("product 38"));
        }
        assert!(result.geometry_hash.is_some());
    }
}

struct RedirectMap {
    index: Arc<EntityIndex>,
}
impl GeometryProcessor for RedirectMap {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        let mesh = ExtrudedAreaSolidProcessor::new(schema.clone())
            .process(entity, decoder, schema, quality)?;
        // A real extension changes the effective ancestry only AFTER producing
        // geometry. Clear the old map memo and install a caller-selected index.
        decoder.clear_entity_cache();
        decoder.set_entity_index(Arc::clone(&self.index));
        Ok(mesh)
    }
}

#[test]
fn presentation_type_map_ancestry_is_resolved_after_real_geometry_callback_mutates_source_lookup() {
    let mut index = ifc_lite_core::build_entity_index(SOURCE);
    index.insert(61, index[&71]);
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = GeometryRouter::with_units(SOURCE, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    router.register(Box::new(RedirectMap {
        index: Arc::new(index),
    }));
    let context = ProductionModel::new().snapshot(OwnedMeshProductionData {
        geometry_style_index: Arc::new(
            [
                (13, GeometryStyleInfo::from_color(RED)),
                (23, GeometryStyleInfo::from_color(GLASS)),
            ]
            .into_iter()
            .collect(),
        ),
        ..Default::default()
    });
    let entity = decoder.decode_by_id(60).unwrap();
    let meta = metadata(60);
    let input = ElementMeshJob {
        kind: ElementJobKind::TypeProduct {
            rep_maps: vec![(61, 1)],
        },
        ..job(&entity, &meta)
    };
    let result =
        produce_element_meshes_owned(&input, &context, &options(), &mut decoder, &router).unwrap();
    assert_eq!(result.meshes.len(), 1);
    assert_eq!(
        result.meshes[0].color, GLASS,
        "late lookup observes the reached extension mutation"
    );
    assert_eq!(result.meshes[0].geometry_class, 1);
    assert!(
        result.geometry_hash.is_none(),
        "type geometry remains excluded from hashing"
    );
    let z = result.meshes[0]
        .positions
        .chunks_exact(3)
        .map(|p| p[2])
        .collect::<Vec<_>>();
    assert_eq!(
        z.iter().copied().fold(f32::NEG_INFINITY, f32::max)
            - z.iter().copied().fold(f32::INFINITY, f32::min),
        3.,
        "already-produced wall-height geometry survives later map redirection to a half-meter slab"
    );
}
