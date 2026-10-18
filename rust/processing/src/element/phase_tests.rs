// SPDX-License-Identifier: MPL-2.0
//! Canonical planning/execution/assembly preservation through actual IFC geometry.
use super::plan::{plan_element, PlanKind, PrimaryStrategy};
use super::*;
use std::sync::Arc;

#[derive(Default)]
struct Context {
    openings: FxHashMap<u32, Vec<u32>>,
    styles: FxHashMap<u32, GeometryStyleInfo>,
    palettes: FxHashMap<u32, FullIndexedColourMap>,
    materials: FxHashMap<u32, Vec<[f32; 4]>>,
    textures: FxHashMap<u32, ResolvedTextureMap>,
}
impl Context {
    fn borrowed(&self) -> MeshProductionContext<'_> {
        MeshProductionContext {
            void_index: &self.openings,
            geometry_style_index: &self.styles,
            indexed_colour_full: &self.palettes,
            element_material_colors: &self.materials,
            texture_index: &self.textures,
            site_local_rotation: None,
        }
    }
}
fn hashed() -> MeshProductionOptions {
    MeshProductionOptions {
        geometry_hash: Some(GeometryHashConfig {
            tolerance: 1e-5,
            world_rtc: [0.; 3],
        }),
    }
}
fn job(entity: &DecodedEntity) -> ElementMeshJob<'_> {
    ElementMeshJob {
        id: entity.id,
        ifc_type: entity.ifc_type.clone(),
        entity,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    }
}
fn bounds(meshes: &[MeshData]) -> [f64; 6] {
    let mut result = [f64::INFINITY; 6];
    result[3..].fill(f64::NEG_INFINITY);
    for mesh in meshes {
        for point in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                let value = f64::from(point[axis]) + mesh.origin[axis];
                result[axis] = result[axis].min(value);
                result[axis + 3] = result[axis + 3].max(value);
            }
        }
    }
    result
}
fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-5, "{actual} != {expected}");
}
fn volume(meshes: &[MeshData]) -> f64 {
    meshes
        .iter()
        .map(|mesh| {
            mesh.indices
                .chunks_exact(3)
                .map(|triangle| {
                    let point = |index: u32| {
                        let offset = index as usize * 3;
                        [
                            f64::from(mesh.positions[offset]),
                            f64::from(mesh.positions[offset + 1]),
                            f64::from(mesh.positions[offset + 2]),
                        ]
                    };
                    let [a, b, c] = [point(triangle[0]), point(triangle[1]), point(triangle[2])];
                    (a[0] * (b[1] * c[2] - b[2] * c[1])
                        + a[1] * (b[2] * c[0] - b[0] * c[2])
                        + a[2] * (b[0] * c[1] - b[1] * c[0]))
                        / 6.
                })
                .sum::<f64>()
                .abs()
        })
        .sum()
}

#[test]
fn null_representation_alignment_executes_real_fallback_and_ordinary_product_is_rejected() {
    let content = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCCARTESIANPOINT((0.,0.,0.));#5=IFCCARTESIANPOINT((10.,0.,0.));
#6=IFCPOLYLINE((#4,#5));
#20=IFCALIGNMENT('a',$,'Road',$,$,$,$,#6);
#21=IFCWALL('w',$,'No representation',$,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;";
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::with_units(content, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.0);
    let context = Context::default();
    let ctx = context.borrowed();
    let alignment = decoder.decode_by_id(20).unwrap();
    let alignment_job = job(&alignment);
    assert!(matches!(
        plan_element(&alignment_job, &ctx, &mut decoder, &router).kind,
        PlanKind::Product {
            primary: PrimaryStrategy::TexturedSubmeshes,
            ..
        }
    ));
    // Without a ProductDefinitionShape, the primary router path has no body;
    // the fallback's dedicated alignment handling must produce the ribbon.
    let primary = router
        .process_element_with_submeshes_textured(&alignment, &mut decoder, &context.textures)
        .unwrap();
    assert!(primary.is_empty());
    let produced = produce_element_meshes(&alignment_job, &ctx, &hashed(), &mut decoder, &router);
    assert!(!produced.meshes.is_empty());
    assert!(produced
        .meshes
        .iter()
        .all(|mesh| mesh.express_id == 20 && mesh.ifc_type == "IfcAlignment"));
    let bbox = bounds(&produced.meshes);
    close(bbox[0], 0.);
    close(bbox[3], 10.);
    close(bbox[1], -0.25);
    close(bbox[4], 0.25);
    assert!(produced.geometry_hash.is_some());
    let wall = decoder.decode_by_id(21).unwrap();
    let wall_job = job(&wall);
    assert!(matches!(
        plan_element(&wall_job, &ctx, &mut decoder, &router).kind,
        PlanKind::NoRepresentation
    ));
    let empty = produce_element_meshes(&wall_job, &ctx, &hashed(), &mut decoder, &router);
    assert!(empty.meshes.is_empty() && empty.instance_occurrences.is_empty());
    assert!(empty.geometry_hash.is_none() && empty.csg_failures.is_empty());
}

const TYPE_MAP: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBOILERTYPE('t',$,'Boiler',$,$,$,(#11),$,$,.NOTDEFINED.);
#11=IFCREPRESENTATIONMAP(#12,#14);#12=IFCAXIS2PLACEMENT3D(#13,$,$);
#13=IFCCARTESIANPOINT((10.,20.,30.));
#14=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#15));
#15=IFCEXTRUDEDAREASOLID(#16,#5,#17,3.);
#16=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);#17=IFCDIRECTION((0.,0.,1.));
ENDSEC;END-ISO-10303-21;";

#[test]
fn type_maps_keep_mapping_origin_class_metadata_and_hash_exclusion() {
    for (instantiated, class) in [(false, 1), (true, 2)] {
        let mut decoder = EntityDecoder::new(TYPE_MAP);
        let router = GeometryRouter::with_units(TYPE_MAP, &mut decoder);
        decoder.seed_unit_scales(router.unit_scale(), 1.0);
        let entity = decoder.decode_by_id(10).unwrap();
        let metadata = ElementMeshMetadata {
            global_id: Some("type-global".into()),
            name: Some("Boiler library".into()),
            ..Default::default()
        };
        let maps = plan_type_geometry(
            &[11],
            &FxHashSet::default(),
            instantiated,
            TypeGeometryMode::EmitTagged,
        );
        let type_job = ElementMeshJob {
            kind: ElementJobKind::TypeProduct { rep_maps: maps },
            metadata: Some(&metadata),
            element_color: Some([0.2, 0.4, 0.6, 1.]),
            ..job(&entity)
        };
        let context = Context::default();
        let ctx = context.borrowed();
        assert!(
            matches!(plan_element(&type_job, &ctx, &mut decoder, &router).kind, PlanKind::TypeMaps(maps) if maps == [(11, class)])
        );
        let produced = produce_element_meshes(&type_job, &ctx, &hashed(), &mut decoder, &router);
        assert_eq!(produced.meshes.len(), 1);
        let mesh = &produced.meshes[0];
        assert_eq!(mesh.geometry_class, class);
        assert_eq!(mesh.global_id.as_deref(), Some("type-global"));
        assert_eq!(mesh.name.as_deref(), Some("Boiler library"));
        assert_eq!(mesh.color, [0.2, 0.4, 0.6, 1.]);
        for (actual, expected) in bounds(&produced.meshes)
            .into_iter()
            .zip([9., 18., 30., 11., 22., 33.])
        {
            close(actual, expected);
        }
        close(volume(&produced.meshes), 24.);
        assert!(produced.geometry_hash.is_none() && produced.geometry_aabb.is_none());
        assert!(produced.instance_occurrences.is_empty());
    }
}

const OPENINGS: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCLOCALPLACEMENT($,#5);#8=IFCDIRECTION((0.,0.,1.));
#10=IFCWALL('w',$,'Panel',$,$,#7,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#5,#8,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,0.1);
#20=IFCOPENINGELEMENT('o',$,'Cut',$,$,#7,#21,$,$);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#24,#25,#8,CUT_HEIGHT);
#24=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,CUT_WIDTH,0.3);
#25=IFCAXIS2PLACEMENT3D(#26,$,$);#26=IFCCARTESIANPOINT((0.,0.,CUT_Z));
#30=IFCRELVOIDSELEMENT('v',$,$,$,#10,#20);
ENDSEC;END-ISO-10303-21;";

#[test]
fn containing_opening_stays_empty_and_window_control_retains_analytic_net_volume() {
    for (width, height, z, expected_volume) in [("2.4", "3.4", "0.", 0.), ("0.5", "1.", "1.", 0.55)]
    {
        let content = OPENINGS
            .replace("CUT_WIDTH", width)
            .replace("CUT_HEIGHT", height)
            .replace("CUT_Z", z);
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);
        decoder.seed_unit_scales(router.unit_scale(), 1.0);
        let entity = decoder.decode_by_id(10).unwrap();
        let job = job(&entity);
        let mut context = Context::default();
        context.openings.insert(10, vec![20]);
        let ctx = context.borrowed();
        assert!(matches!(
            plan_element(&job, &ctx, &mut decoder, &router).kind,
            PlanKind::Product {
                primary: PrimaryStrategy::VoidedSubmeshes,
                ..
            }
        ));
        let produced = produce_element_meshes(&job, &ctx, &hashed(), &mut decoder, &router);
        if expected_volume == 0. {
            assert!(
                produced.meshes.is_empty(),
                "consumed host must not reappear through fallback"
            );
            assert!(produced.instance_occurrences.is_empty());
            assert!(produced.geometry_hash.is_none());
        } else {
            assert!(
                !produced.meshes.is_empty(),
                "ordinary opening must leave a host"
            );
            close(volume(&produced.meshes), expected_volume);
            assert!(produced.meshes.iter().all(|mesh| mesh.express_id == 10));
        }
    }
}

#[test]
fn warm_instance_only_success_does_not_materialize_fallback_geometry() {
    let content = include_str!("../../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let mut decoder = EntityDecoder::new(content);
    let mut router = GeometryRouter::with_units(content, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.0);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    router.enable_output_instancing(Arc::new([(16, (16, 25))].into_iter().collect()));
    router.set_instancing_batch_local(true);
    let context = Context::default();
    let ctx = context.borrowed();
    let first = decoder.decode_by_id(31).unwrap();
    let template = produce_element_meshes(&job(&first), &ctx, &hashed(), &mut decoder, &router);
    assert!(!template.meshes.is_empty() && template.instance_occurrences.is_empty());
    close(volume(&template.meshes), 1.);
    let second = decoder.decode_by_id(38).unwrap();
    let produced = produce_element_meshes(&job(&second), &ctx, &hashed(), &mut decoder, &router);
    assert!(
        produced.meshes.is_empty(),
        "occurrence-only success must never retry as a flat mesh"
    );
    assert_eq!(produced.instance_occurrences.len(), 1);
    let occurrence = &produced.instance_occurrences[0];
    assert_eq!(occurrence.express_id, 38);
    // This source occurrence is authored at (3,2,0), with unit source geometry.
    close(occurrence.world_transform[3], 3.);
    close(occurrence.world_transform[7], 2.);
    close(occurrence.world_transform[11], 0.);
    assert!(produced.csg_failures.is_empty());
}
