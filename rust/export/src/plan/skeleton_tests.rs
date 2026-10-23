// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::plan::add_test_support::{add, assert_clean, block, count, id_in, run, IDENTITY};
use crate::plan::{ClassSpec, IfcClass, NewObject, NewPlacement, ObjectRef, Representation};

fn root(n: u128, name: &str) -> SkeletonRoot {
    SkeletonRoot {
        global_id: GlobalId(0x5ce1_0000_0000_0000_0000_0000_0000_0000 + n),
        name: Some(name.into()),
    }
}

fn a_skeleton(map: Option<MapConversion>) -> Skeleton {
    Skeleton {
        project: root(1, "Project"),
        site: root(2, "Site"),
        building: root(3, "Building"),
        true_north: map.as_ref().map(|_| [0.5, 0.866]),
        map_conversion: map,
    }
}

fn a_map() -> MapConversion {
    MapConversion {
        crs_name: "EPSG:2056".into(),
        eastings: 2_600_000.0,
        northings: 1_200_000.0,
        orthogonal_height: 400.0,
        x_axis_abscissa: 0.866,
        x_axis_ordinate: -0.5,
        scale: None,
    }
}

fn object(
    class: IfcClass,
    n: u128,
    container: Option<ObjectRef>,
    representation: Representation,
) -> NewObject {
    NewObject {
        global_id: GlobalId(0xadd0_0000_0000_0000_0000_0000_0000_0000 + n),
        class: ClassSpec {
            class,
            predefined_type: None,
        },
        name: None,
        placement: NewPlacement {
            matrix: IDENTITY,
            relative_to: None,
        },
        container,
        type_link: None,
        representation,
        style: None,
        psets: Vec::new(),
        opening: None,
    }
}

#[test]
fn a_skeleton_takes_a_storey_and_a_wall_and_validates() {
    for map in [None, Some(a_map())] {
        let source = skeleton(&a_skeleton(map.clone())).expect("skeleton");
        let building = ObjectRef::Guid(root(3, "").global_id.encode());
        let storey = object(
            IfcClass::BuildingStorey,
            1,
            Some(building),
            Representation::None,
        );
        let storey_ref = ObjectRef::Guid(storey.global_id.encode());
        let wall = object(
            IfcClass::Wall,
            2,
            Some(storey_ref),
            Representation::Extrusion(block(4.0, 0.2, 3.0)),
        );
        let (out, report) = run(&source, vec![add(storey.clone()), add(wall.clone())]);
        assert_clean(&report, "skeleton");
        assert_eq!(report.added, 2);
        id_in(&out, wall.global_id);
        assert_eq!(count(&out, "IFCPROJECT"), 1);
        assert_eq!(
            count(&out, "IFCRELAGGREGATES"),
            3,
            "project-site, site-building, building-storey"
        );
        assert_eq!(count(&out, "IFCMAPCONVERSION"), usize::from(map.is_some()));
        assert_eq!(count(&out, "IFCPROJECTEDCRS"), usize::from(map.is_some()));
    }
}

#[test]
fn the_same_skeleton_is_the_same_bytes() {
    let s = a_skeleton(Some(a_map()));
    assert_eq!(skeleton(&s).expect("first"), skeleton(&s).expect("second"));
}

#[test]
fn the_body_subcontext_is_the_one_new_geometry_goes_into() {
    let source = skeleton(&a_skeleton(None)).expect("skeleton");
    let wall = object(
        IfcClass::Wall,
        2,
        None,
        Representation::Extrusion(block(1.0, 1.0, 1.0)),
    );
    let (out, report) = run(&source, vec![add(wall)]);
    assert_clean(&report, "body context");
    assert_eq!(
        count(&out, "IFCGEOMETRICREPRESENTATIONCONTEXT"),
        1,
        "no second context is synthesized"
    );
    let text = String::from_utf8(out).expect("utf8");
    let sub = text
        .lines()
        .find(|l| l.contains("IFCGEOMETRICREPRESENTATIONSUBCONTEXT"))
        .expect("subcontext");
    let sub_id = &sub[..sub.find('=').expect("record")];
    assert!(
        text.lines()
            .any(|l| l.contains(&format!("IFCSHAPEREPRESENTATION({sub_id},"))),
        "the body is in {sub_id}"
    );
}

#[test]
fn bad_inputs_are_refused() {
    let mut s = a_skeleton(None);
    s.site.global_id = s.project.global_id;
    assert!(skeleton(&s).unwrap_err().contains("distinct"));

    let mut s = a_skeleton(None);
    s.true_north = Some([0.0, 0.0]);
    assert!(skeleton(&s).unwrap_err().contains("true north"));

    let mut m = a_map();
    m.crs_name = " ".into();
    assert!(skeleton(&a_skeleton(Some(m)))
        .unwrap_err()
        .contains("CRS name"));

    let mut m = a_map();
    m.eastings = f64::NAN;
    assert!(skeleton(&a_skeleton(Some(m)))
        .unwrap_err()
        .contains("not finite"));

    let mut m = a_map();
    m.scale = Some(0.0);
    assert!(skeleton(&a_skeleton(Some(m)))
        .unwrap_err()
        .contains("positive"));
}
