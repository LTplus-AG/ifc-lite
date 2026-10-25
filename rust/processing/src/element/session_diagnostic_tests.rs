// SPDX-License-Identifier: MPL-2.0
//! Type-map diagnostics retain the canonical final processor-drain ordering.
use super::*;
use super::session::ProductState;

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
        MeshProductionContext { void_index: &self.openings, geometry_style_index: &self.styles,
            indexed_colour_full: &self.palettes, element_material_colors: &self.materials,
            texture_index: &self.textures, site_local_rotation: None }
    }
}

const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBOILERTYPE('t',$,'Library',$,$,$,(#11,#21,#31,#41),$,$,.NOTDEFINED.);
#11=IFCREPRESENTATIONMAP(#5,#12);
#12=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#14));
#13=IFCBLOCK($,1.,1.,1.);#14=IFCBOOLEANRESULT(.XOR.,#13,$);
#21=IFCREPRESENTATIONMAP(#5,#22);
#22=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#25));
#23=IFCBLOCK($,2.,1.,1.);#24=IFCBOOLEANRESULT(.NOR.,#23,$);#25=IFCCSGSOLID(#24);
#31=IFCREPRESENTATIONMAP(#5,#32);
#32=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#34));
#33=IFCBLOCK($,3.,1.,1.);#34=IFCBOOLEANRESULT(.XOR.,#33,$);
#41=IFCREPRESENTATIONMAP(#5,#42);
#42=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#45));
#43=IFCBLOCK($,4.,1.,1.);#44=IFCBOOLEANRESULT(.NOR.,#43,$);#45=IFCCSGSOLID(#44);
ENDSEC;END-ISO-10303-21;";

fn volume(positions: &[f32], indices: &[u32]) -> f64 {
    indices.chunks_exact(3).map(|triangle| {
        let point = |index: u32| {
            let offset = index as usize * 3;
            nalgebra::Vector3::new(f64::from(positions[offset]),
                f64::from(positions[offset + 1]), f64::from(positions[offset + 2]))
        };
        point(triangle[0]).dot(&point(triangle[1]).cross(&point(triangle[2]))) / 6.
    }).sum::<f64>().abs()
}

#[test]
fn type_map_polling_preserves_the_single_final_drain_order_across_distinct_processors() {
    let context = Context::default();
    let ctx = context.borrowed();
    let maps = [11, 21, 31, 41];
    let mut oracle_decoder = EntityDecoder::new(SOURCE);
    let oracle_router = GeometryRouter::with_units(SOURCE, &mut oracle_decoder);
    oracle_decoder.seed_unit_scales(oracle_router.unit_scale(), 1.);
    let mut oracle_volumes = Vec::new();
    for id in maps {
        let map = oracle_decoder.decode_by_id(id).unwrap();
        let parts = oracle_router.process_representation_map_with_texture(
            &map, &mut oracle_decoder, &context.textures).unwrap();
        assert_eq!(parts.len(), 1, "each actual map must construct its block");
        oracle_volumes.push(volume(&parts[0].0.positions, &parts[0].0.indices));
    }
    // The compatibility oracle is the real pre-session call sequence: execute
    // every map, then drain once. Processor streams are grouped at that drain.
    let expected = oracle_router.take_csg_failures();
    assert_eq!(expected.len(), 1, "these constructor failures share one unattributed bucket");
    let ordered = expected.values().next().unwrap();
    assert_eq!(ordered.len(), 4);
    let keywords: Vec<_> = ordered.iter().map(|failure| {
        assert_eq!(failure.op, ifc_lite_geometry::BoolOp::Unknown);
        let ifc_lite_geometry::BoolFailureReason::UnknownBooleanOperator(keyword) = &failure.reason
            else { panic!("expected source operator refusal: {failure:?}") };
        keyword.as_str()
    }).collect();
    assert_eq!(keywords, ["XOR", "XOR", "NOR", "NOR"],
        "final processor grouping differs from alternating map/poll order");
    for (actual, expected) in oracle_volumes.iter().zip([1., 2., 3., 4.]) {
        assert!((actual - expected).abs() < 1e-12);
    }

    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    let entity = decoder.decode_by_id(10).unwrap();
    let job = ElementMeshJob { id: entity.id, ifc_type: entity.ifc_type.clone(), entity: &entity,
        kind: ElementJobKind::TypeProduct { rep_maps: maps.into_iter().map(|id| (id, 1)).collect() },
        element_color: None, metadata: None };
    let mut execution = ProductState::new(&job, &ctx, &MeshProductionOptions::default(),
        &mut decoder, &router).unwrap();
    while execution.advance(&ctx, &mut decoder, &router).unwrap() {}
    let actual = execution.finish(&decoder, &router).unwrap();
    assert_eq!(actual.csg_failures, expected, "polls must not reorder processor failure streams");
    assert_eq!(actual.meshes.len(), 4);
    for (mesh, expected_volume) in actual.meshes.iter().zip(oracle_volumes) {
        assert!((volume(&mesh.positions, &mesh.indices) - expected_volume).abs() < 1e-12);
        assert_eq!(mesh.geometry_class, 1);
    }
    assert!(router.take_csg_failures().is_empty(), "final publication drains once completely");
}
