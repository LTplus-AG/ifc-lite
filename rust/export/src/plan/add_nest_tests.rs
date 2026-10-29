// SPDX-License-Identifier: MPL-2.0
//! Disposition::Add with `nest_in`: ports nested on a new host, on a host
//! in the source, and the hosts that are refused.

use ifc_lite_core::EntityDecoder;

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::test_fixtures::{gid as fixture_gid, host_with_port_type_and_body, storey_with_typed_wall};
use crate::plan::types::*;

fn port(n: u128, host: ObjectRef) -> NewObject {
    object(IfcClass::Named("IfcDistributionPort".into()), gid(n), None, Representation::None).with_nest_in(host)
}

/// The ports `host` holds through `IfcRelConnectsPortToElement`.
fn connected_ports(out: &[u8], host: u32) -> Vec<u32> {
    let mut decoder = EntityDecoder::new(out);
    let connects = ids_of_type(out, "IFCRELCONNECTSPORTTOELEMENT").into_iter().map(|id| decoder.decode_by_id(id).unwrap());
    connects.filter(|rel| rel.get_ref(5) == Some(host)).filter_map(|rel| rel.get_ref(4)).collect()
}

/// What `host` nests through its one `IfcRelNests`, in file order.
fn nested_in(out: &[u8], host: u32) -> Vec<u32> {
    let mut decoder = EntityDecoder::new(out);
    let nests = ids_of_type(out, "IFCRELNESTS").into_iter().map(|id| decoder.decode_by_id(id).unwrap());
    let nests: Vec<_> = nests.filter(|rel| rel.get_ref(4) == Some(host)).collect();
    assert_eq!(nests.len(), 1, "one IfcRelNests per host");
    nests[0].get_refs(5).unwrap()
}

/// The ports `host` holds: connected in IFC2X3, which nests none under an
/// element, nested otherwise, and only that way.
fn ports_of(out: &[u8], schema: &str, host: u32) -> Vec<u32> {
    if schema == "IFC2X3" {
        assert_eq!(count(out, "IFCRELNESTS"), 0, "{schema}");
        connected_ports(out, host)
    } else {
        assert!(connected_ports(out, host).is_empty(), "{schema}");
        nested_in(out, host)
    }
}

#[test]
fn a_new_host_with_two_new_ports_round_trips_in_every_schema() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let class = if schema == "IFC2X3" { "IfcFlowSegment" } else { "IfcPipeSegment" };
        let pipe = object(IfcClass::Named(class.into()), gid(1), Some(ObjectRef::Id(70)), Representation::Extrusion(block(3.0, 0.1, 0.1)));
        let host = ObjectRef::Guid(gid(1).encode());
        let mut end = port(3, host.clone());
        end.placement.matrix = translated(3.0);
        let (out, report) = run(&source, vec![add(pipe), add(port(2, host)), add(end)]);
        assert_valid(&out, &report, schema);
        assert_eq!(report.added, 3, "{schema}");

        let (pipe, start, end) = (id_in(&out, gid(1)), id_in(&out, gid(2)), id_in(&out, gid(3)));
        assert_eq!(ports_of(&out, schema, pipe), [start, end], "{schema}");
        let mut decoder = EntityDecoder::new(&out);
        let pipe_placement = decoder.decode_by_id(pipe).unwrap().get_ref(5).unwrap();
        for p in [start, end] {
            let placement = decoder.decode_by_id(p).unwrap().get_ref(5).unwrap();
            assert_eq!(decoder.decode_by_id(placement).unwrap().get_ref(0), Some(pipe_placement), "{schema}: a port is placed on its host");
        }
        let rels = crate::relationships(&out);
        assert!(rels.spatial_children[&70].contains(&pipe), "{schema}: the host stays contained");
        assert!(!rels.spatial_children[&70].contains(&start), "{schema}: a port is not contained");
    }
}

/// The fixture nests port `#14` on wall `#10` through `#18`, in IFC2X3 too
/// (where it also connects it through `#19`), so this checks what the new
/// port adds rather than the whole file's validity.
#[test]
fn a_port_nested_under_a_host_in_the_source_joins_its_existing_nesting() {
    for schema in SCHEMAS {
        let (out, report) = run(&host_with_port_type_and_body(schema), vec![add(port(1, ObjectRef::Guid(fixture_gid(10))))]);
        assert_clean(&report, schema);
        let new_port = id_in(&out, gid(1));
        assert_eq!(count(&out, "IFCRELNESTS"), 1, "{schema}: extended or left alone, not duplicated");
        let (nested, connected) = (nested_in(&out, 10), connected_ports(&out, 10));
        if schema == "IFC2X3" {
            assert_eq!((nested, connected), (vec![14], vec![14, new_port]), "{schema}");
        } else {
            assert_eq!(nested, [14, new_port], "{schema}");
            assert!(!connected.contains(&new_port), "{schema}");
        }
    }
}

#[test]
fn a_port_under_a_host_with_no_nesting_gets_one() {
    for schema in SCHEMAS {
        let (out, report) = run(&storey_with_typed_wall(schema), vec![add(port(1, ObjectRef::Id(10))), add(port(2, ObjectRef::Id(10)))]);
        assert_valid(&out, &report, schema);
        assert_eq!(ports_of(&out, schema, 10), [id_in(&out, gid(1)), id_in(&out, gid(2))], "{schema}");
    }
}

#[test]
fn a_host_that_cannot_hold_the_object_is_refused_and_nothing_is_written() {
    let storey = object(IfcClass::BuildingStorey, gid(1), Some(ObjectRef::Id(60)), Representation::None).with_nest_in(ObjectRef::Id(70));
    let cases: [(&str, NewObject, bool, &str); 6] = [
        ("IFC4", port(1, ObjectRef::Guid(gid(99).encode())), false, "not found"),
        ("IFC4", port(1, ObjectRef::Id(40)), false, "IFCWALLTYPE, not a product"),
        ("IFC2X3", port(1, ObjectRef::Id(70)), false, "IFC2X3 connects a port only to an element"),
        (
            "IFC2X3",
            object(IfcClass::Window, gid(1), None, Representation::None).with_nest_in(ObjectRef::Id(10)),
            false,
            "IFC2X3 nests a IFCWINDOW only under another IFCWINDOW",
        ),
        ("IFC4", port(1, ObjectRef::Id(10)), true, "deleted by this plan"),
        ("IFC2X3", storey, false, "aggregated into its container and cannot also be nested"),
    ];
    for (n, (schema, obj, delete_host, reason)) in cases.into_iter().enumerate() {
        let source = storey_with_typed_wall(schema);
        let delete = delete_host.then_some((ObjectRef::Id(10), Disposition::Delete));
        let plan = delete.into_iter().chain([add(obj)]).collect();
        let (out, report) = run(&source, plan);
        assert_eq!(report.added, 0, "case {n}");
        assert_eq!(report.refusals.len(), 1, "case {n}: {:?}", report.refusals);
        assert_eq!(report.refusals[0].object, ObjectRef::Guid(gid(1).encode()), "case {n}");
        assert!(report.refusals[0].reason.contains(reason), "case {n}: {}", report.refusals[0].reason);
        assert_eq!(count(&out, "IFCRELNESTS") + count(&out, "IFCRELCONNECTSPORTTOELEMENT"), 0, "case {n}");
    }
}

#[test]
fn ifc2x3_nests_an_object_under_one_of_its_own_class() {
    let source = storey_with_typed_wall("IFC2X3");
    let part = object(IfcClass::Wall, gid(1), None, Representation::None).with_nest_in(ObjectRef::Id(10));
    let (out, report) = run(&source, vec![add(part)]);
    assert_valid(&out, &report, "IFC2X3");
    let mut decoder = EntityDecoder::new(&out);
    let nests = decoder.decode_by_id(ids_of_type(&out, "IFCRELNESTS")[0]).unwrap();
    assert_eq!(nests.get_ref(4), Some(10));
    assert_eq!(nests.get_refs(5).unwrap(), [id_in(&out, gid(1))]);
}

/// A host with no placement of its own leaves the object placed by its
/// container, as it would be without a host.
#[test]
fn an_object_nested_under_a_host_without_a_placement_is_placed_by_its_container() {
    let source = String::from_utf8(storey_with_typed_wall("IFC4")).unwrap();
    let wall = "'Wall 1',$,$,#20,";
    assert!(source.contains(wall), "the fixture's wall line changed");
    let source = source.replacen(wall, "'Wall 1',$,$,$,", 1);
    let mut proxy = object(IfcClass::BuildingElementProxy, gid(1), Some(ObjectRef::Id(70)), Representation::None);
    proxy.nest_in = Some(ObjectRef::Id(10));
    let (out, report) = run(source.as_bytes(), vec![add(proxy)]);
    assert_clean(&report, "IFC4");
    let mut decoder = EntityDecoder::new(&out);
    let placement = decoder.decode_by_id(id_in(&out, gid(1))).unwrap().get_ref(5).unwrap();
    assert_eq!(decoder.decode_by_id(placement).unwrap().get_ref(0), Some(73), "the storey's placement");
    assert_eq!(nested_in(&out, 10), [id_in(&out, gid(1))]);
}
