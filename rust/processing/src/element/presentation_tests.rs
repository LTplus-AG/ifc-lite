// SPDX-License-Identifier: MPL-2.0
//! Late presentation regressions through the canonical geometry producer.
//! The inline STEP models state invariants; they are not exporter evidence.
use super::*;
use std::sync::Arc;

pub(super) const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#17=IFCAXIS2PLACEMENT3D(#18,$,$);#18=IFCCARTESIANPOINT((-4.,3.,2.));
#19=IFCLOCALPLACEMENT($,#17);#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);
#60=IFCBOILERTYPE('t',$,'Library',$,$,$,(#61,#71),$,$,.NOTDEFINED.);
#61=IFCREPRESENTATIONMAP(#7,#12);#71=IFCREPRESENTATIONMAP(#17,#22);
ENDSEC;END-ISO-10303-21;";

const RED: [f32; 4] = [0.9, 0.1, 0.2, 1.];
const GLASS: [f32; 4] = [0.1, 0.8, 0.6, 0.3];

/// Owned storage behind one borrowed [`MeshProductionContext`].
#[derive(Default)]
pub(super) struct Data {
    pub styles: FxHashMap<u32, GeometryStyleInfo>,
    pub palettes: FxHashMap<u32, FullIndexedColourMap>,
    pub materials: FxHashMap<u32, Vec<[f32; 4]>>,
    pub textures: FxHashMap<u32, ResolvedTextureMap>,
    pub openings: FxHashMap<u32, Vec<u32>>,
}
impl Data {
    pub fn ctx(&self) -> MeshProductionContext<'_> {
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

pub(super) fn options() -> MeshProductionOptions {
    MeshProductionOptions {
        geometry_hash: Some(GeometryHashConfig {
            tolerance: 1e-5,
            world_rtc: [8., 16., 0.],
        }),
    }
}
pub(super) fn metadata(id: u32) -> ElementMeshMetadata {
    ElementMeshMetadata {
        global_id: Some(format!("global-{id}")),
        name: Some(format!("product {id}")),
        presentation_layer: Some("layer A".into()),
        space_zone_properties: Some([("Reference".into(), "space property".into())].into()),
    }
}
pub(super) fn job<'a>(entity: &'a DecodedEntity, metadata: &'a ElementMeshMetadata) -> ElementMeshJob<'a> {
    ElementMeshJob {
        id: entity.id,
        ifc_type: entity.ifc_type.clone(),
        entity,
        kind: ElementJobKind::Product,
        element_color: Some([0.1, 0.4, 0.8, 1.]),
        metadata: Some(metadata),
    }
}

fn produce(id: u32, data: &Data) -> ProducedElementMeshes {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = GeometryRouter::with_units(SOURCE, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    router.set_rtc_offset((8., 16., 0.));
    let entity = decoder.decode_by_id(id).unwrap();
    let meta = metadata(id);
    produce_element_meshes(&job(&entity, &meta), &data.ctx(), &options(), &mut decoder, &router)
}

#[test]
fn presentation_repairs_winding_and_normals_against_analytic_tetrahedron_8049() {
    // Unit-axis tetrahedron: outward area-weighted vertex normals are
    // (-1,-1,-1)/sqrt(3) at the origin and +X/+Y/+Z at the other vertices.
    // Unlike the style comparison below, these expectations are independent
    // of another presentation path and of the production normal calculator.
    for inward in [false, true] {
        let mut mesh = ifc_lite_geometry::Mesh::new();
        mesh.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.];
        mesh.indices = vec![0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
        if inward {
            for triangle in mesh.indices.chunks_exact_mut(3) {
                triangle.swap(1, 2);
            }
            // Correct length, deliberately stale: a flip must recompute them.
            mesh.normals = [0., 0., -1.].repeat(4);
        } // The outward case instead requires repairing a missing channel.
        let mut collection = SubMeshCollection::new();
        collection.sub_meshes.push(ifc_lite_geometry::SubMesh::new(13, mesh));
        let mut decoder = EntityDecoder::new(SOURCE);
        let entity = decoder.decode_by_id(10).unwrap();
        let meta = metadata(10);
        let data = Data::default();
        let (meshes, occurrences) = super::presentation_source::submeshes(
            &AssemblyJob::from(&job(&entity, &meta)), collection, RED,
            &data.ctx(), &mut decoder, &mut None, 0,
        );
        assert!(occurrences.is_empty());
        assert_eq!(meshes.len(), 1);
        let output = &meshes[0];
        assert_eq!(output.indices.len(), 12);
        assert_eq!(output.normals.len(), output.positions.len());
        for (point, normal) in output.positions.chunks_exact(3).zip(output.normals.chunks_exact(3)) {
            let expected = match point {
                [0., 0., 0.] => [-1. / 3_f32.sqrt(); 3],
                [1., 0., 0.] => [1., 0., 0.],
                [0., 1., 0.] => [0., 1., 0.],
                [0., 0., 1.] => [0., 0., 1.],
                _ => panic!("unexpected tetrahedron vertex {point:?}"),
            };
            for axis in 0..3 {
                assert!((normal[axis] - expected[axis]).abs() < 1e-6, "inward={inward}: {point:?}, {normal:?}");
            }
        }
        for face in output.indices.chunks_exact(3) {
            let vertex = |i: u32| nalgebra::Vector3::from_row_slice(&output.positions[i as usize * 3..i as usize * 3 + 3]);
            let (a, b, c) = (vertex(face[0]), vertex(face[1]), vertex(face[2]));
            let normal = (b - a).cross(&(c - a));
            let from_inside = a - nalgebra::Vector3::repeat(0.25);
            assert!(normal.dot(&from_inside) > 0., "every face must point away from the tetrahedron centroid");
        }
    }
}

#[test]
fn presentation_direct_style_precedes_materials_on_real_extrusion_without_changing_hash_or_frames() {
    let plain = produce(10, &Data::default());
    let mut style = GeometryStyleInfo::from_color(RED);
    style.material_name = Some("Authored finish".into());
    let data = Data {
        styles: [(13, style)].into_iter().collect(),
        materials: [(10, vec![GLASS])].into_iter().collect(),
        ..Default::default()
    };
    let colored = produce(10, &data);
    let (mesh, base) = (&colored.meshes[0], &plain.meshes[0]);
    assert_eq!(mesh.color, RED);
    assert_eq!(mesh.material_name.as_deref(), Some("Authored finish"));
    assert_eq!((mesh.geometry_item_id, mesh.material_id), (Some(13), None));
    assert_eq!(mesh.global_id.as_deref(), Some("global-10"));
    assert_eq!(mesh.presentation_layer.as_deref(), Some("layer A"));
    assert_eq!(mesh.properties, metadata(10).space_zone_properties);
    assert_eq!(mesh.positions, base.positions);
    assert_eq!(mesh.indices, base.indices);
    assert_eq!(mesh.normals, base.normals);
    assert_eq!(mesh.origin, base.origin);
    assert_eq!(colored.geometry_hash, plain.geometry_hash);
    assert_eq!(colored.geometry_closure, plain.geometry_closure);
    assert_eq!(colored.geometry_volume, plain.geometry_volume);
}

#[test]
fn presentation_one_material_cursor_crosses_real_instance_only_and_materialized_parts() {
    let original = include_str!("../../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    for items in ["#32,#600,#39,#601", "#600,#32,#601,#39"] {
        let source = original
            .replace("MappedRepresentation',(#32)", &format!("MappedRepresentation',({items})"))
            .replace(
                "ENDSEC;\nEND-ISO",
                "#600=IFCEXTRUDEDAREASOLID(#8,#11,#9,2.);\n#601=IFCEXTRUDEDAREASOLID(#8,#11,#9,3.);\nENDSEC;\nEND-ISO",
            );
        let mut decoder = EntityDecoder::new(&source);
        let mut router = GeometryRouter::with_units(&source, &mut decoder);
        decoder.seed_unit_scales(router.unit_scale(), 1.);
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        router.enable_output_instancing(Arc::new([(16, (16, 25))].into_iter().collect()));
        router.set_instancing_batch_local(true);
        let data = Data {
            materials: [(38, vec![RED, GLASS])].into_iter().collect(),
            ..Default::default()
        };
        let first = decoder.decode_by_id(31).unwrap();
        let first_meta = metadata(31);
        let template =
            produce_element_meshes(&job(&first, &first_meta), &data.ctx(), &options(), &mut decoder, &router);
        assert_eq!(template.meshes.len(), 1, "first occurrence materializes its template");
        let second = decoder.decode_by_id(38).unwrap();
        let second_meta = metadata(38);
        let result =
            produce_element_meshes(&job(&second, &second_meta), &data.ctx(), &options(), &mut decoder, &router);
        assert_eq!(result.meshes.len(), 2);
        assert_eq!(result.instance_occurrences.len(), 2);
        // The canonical cursor starts with transparent preference regardless of
        // material-list order; its next part prefers opaque, and both output
        // channels advance that same cursor in the reached collection order.
        let (body, instance) = if items.starts_with("#32") { (RED, GLASS) } else { (GLASS, RED) };
        assert_eq!(result.meshes.iter().map(|m| m.color).collect::<Vec<_>>(), [body, body], "{items}");
        assert_eq!(
            result.instance_occurrences.iter().map(|o| o.color).collect::<Vec<_>>(),
            [instance, instance],
            "{items}"
        );
        assert_eq!(
            result.meshes.iter().map(|m| m.geometry_item_id).collect::<Vec<_>>(),
            [Some(600), Some(601)]
        );
        for occurrence in &result.instance_occurrences {
            assert_eq!(occurrence.geometry_item_id, Some(12));
            assert_eq!(occurrence.world_transform[3], 3.);
            assert_eq!(occurrence.world_transform[7], 2.);
            assert_eq!(occurrence.name.as_deref(), Some("product 38"));
            assert_eq!(occurrence.presentation_layer.as_deref(), Some("layer A"));
        }
        assert!(result.geometry_hash.is_some());
    }
}
