// SPDX-License-Identifier: MPL-2.0
//! An Add's material, classifications and value units: reusing the
//! source's records and relationships, sharing new records across Adds, and
//! refusing what the schema cannot hold. Synthetic fixtures only.

use crate::plan::add_assoc_types::*;
use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::attrs::{build_record, unset_required};
use crate::plan::index::FileIndex;
use crate::plan::test_fixtures::storey_with_typed_wall;
use crate::plan::types::*;

/// Wall `#10` of `storey_with_typed_wall` with a material, a classification
/// reference and their relationships, plus a kilopascal and a derived unit.
fn associated_wall(schema: &str) -> Vec<u8> {
    let r = |id, entity, fields: &[(&str, &str)]| {
        let mut fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
        // IFC2X3 requires an owner history: the fixture preamble's.
        if schema == "IFC2X3" {
            fields.push(("OwnerHistory", "#5".into()));
        }
        build_record(schema, id, entity, &fields) + "\n"
    };
    let ident = if schema == "IFC2X3" { "ItemReference" } else { "Identification" };
    let extra = [
        r(200, "IFCMATERIAL", &[("Name", "'Concrete'")]),
        r(201, "IFCRELASSOCIATESMATERIAL", &[("GlobalId", "'0000000000000000000201'"), ("RelatedObjects", "(#10)"), ("RelatingMaterial", "#200")]),
        r(210, "IFCCLASSIFICATION", &[("Source", "'src'"), ("Edition", "'1'"), ("Name", "'Uniclass'")]),
        r(211, "IFCCLASSIFICATIONREFERENCE", &[(ident, "'EF_25_10'"), ("Name", "'Walls'"), ("ReferencedSource", "#210")]),
        r(212, "IFCRELASSOCIATESCLASSIFICATION", &[("GlobalId", "'0000000000000000000212'"), ("RelatedObjects", "(#10)"), ("RelatingClassification", "#211")]),
        r(220, "IFCSIUNIT", &[("Dimensions", "*"), ("UnitType", ".PRESSUREUNIT."), ("Prefix", ".KILO."), ("Name", ".PASCAL.")]),
        r(221, "IFCDERIVEDUNIT", &[("Elements", "(#222)"), ("UnitType", ".LINEARVELOCITYUNIT.")]),
        r(222, "IFCDERIVEDUNITELEMENT", &[("Unit", "#51"), ("Exponent", "1")]),
        r(223, "IFCCONTEXTDEPENDENTUNIT", &[("Dimensions", "#224"), ("UnitType", ".USERDEFINED."), ("Name", "'step'")]),
        r(224, "IFCDIMENSIONALEXPONENTS", &[
            ("LengthExponent", "0"), ("MassExponent", "0"), ("TimeExponent", "0"), ("ElectricCurrentExponent", "0"),
            ("ThermodynamicTemperatureExponent", "0"), ("AmountOfSubstanceExponent", "0"), ("LuminousIntensityExponent", "0"),
        ]),
        r(225, "IFCMONETARYUNIT", &[("Currency", if schema == "IFC2X3" { ".EUR." } else { "'EUR'" })]),
    ]
    .concat();
    let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
    text.replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1).into_bytes()
}

fn wall(n: u128) -> NewObject {
    object(IfcClass::Wall, gid(n), Some(ObjectRef::Id(70)), Representation::Extrusion(block(1.0, 0.2, 2.0)))
}

fn concrete() -> NewMaterial {
    NewMaterial { name: "Concrete C30".into(), category: None }
}

fn uniclass() -> ClassificationSystem {
    ClassificationSystem::New(NewClassification { name: "Uniclass".into(), source: Some("NBS".into()), edition: Some("2015".into()) })
}

fn reference(id: &str) -> ClassificationLink {
    ClassificationLink::New(NewClassificationReference { system: uniclass(), identification: Some(id.into()), name: None, location: None })
}

fn measure(name: &str, measure_type: &str, value: f64, unit: Option<ValueUnit>) -> NewProperty {
    NewProperty { name: name.into(), value: PropertyValue::Measure { measure_type: measure_type.into(), value }, unit }
}

fn set(name: &str, kind: PsetKind, properties: Vec<NewProperty>) -> NewPropertySet {
    NewPropertySet { name: name.into(), kind, properties }
}

/// The checks every output here gets: no refusal, no finding from the
/// executor or from a whole-file validation, and no new record leaving a
/// mandatory slot unset.
fn assert_valid(out: &[u8], report: &WriteReport, schema: &str) {
    assert_clean(report, schema);
    assert!(crate::plan::validate::validate(out, schema).is_empty(), "{schema}: {:?}", crate::plan::validate::validate(out, schema));
    let index = FileIndex::scan(out, &Default::default());
    for (id, _, _, _) in index.records() {
        let line = index.raw_line(id).unwrap();
        assert!(unset_required(schema, &line).is_empty(), "{schema}: #{id} leaves {:?} unset: {line}", unset_required(schema, &line));
    }
}

fn refused(source: &[u8], obj: NewObject) -> String {
    let (out, report) = run(source, vec![add(obj)]);
    assert_eq!(report.added, 0);
    assert_eq!(out.len(), run(source, Vec::new()).0.len(), "a refused Add writes nothing");
    report.refusals.first().map(|r| r.reason.clone()).expect("refused")
}

#[test]
fn a_copy_joins_its_sources_material_and_classification_relationships() {
    for schema in SCHEMAS {
        let source = associated_wall(schema);
        let mut copy = wall(1);
        copy.material = Some(MaterialLink::Existing(ObjectRef::Id(200)));
        copy.classifications = vec![ClassificationLink::Existing(ObjectRef::Id(211))];
        let (out, report) = run(&source, vec![add(copy)]);
        assert_valid(&out, &report, schema);
        let copy = id_in(&out, gid(1));
        assert_eq!(count(&out, "IFCMATERIAL"), 1, "{schema}: the source's material is reused");
        assert_eq!(count(&out, "IFCCLASSIFICATIONREFERENCE"), 1, "{schema}");
        assert_eq!(count(&out, "IFCRELASSOCIATESMATERIAL"), 1, "{schema}: extended, not duplicated");
        assert_eq!(count(&out, "IFCRELASSOCIATESCLASSIFICATION"), 1, "{schema}");
        assert_eq!(attr(&out, schema, 201, "RelatedObjects"), format!("(#10,#{copy})"), "{schema}");
        assert_eq!(attr(&out, schema, 212, "RelatedObjects"), format!("(#10,#{copy})"), "{schema}");
    }
}

#[test]
fn a_new_material_and_classification_are_written_once_for_every_add_naming_them() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let adds = (1..=3)
            .map(|n| {
                let mut w = wall(n);
                w.material = Some(MaterialLink::New(concrete()));
                w.classifications = vec![reference("EF_25_10"), reference(&format!("Ss_{n}"))];
                add(w)
            })
            .collect();
        let (out, report) = run(&source, adds);
        assert_valid(&out, &report, schema);
        assert_eq!(report.added, 3);
        assert_eq!(count(&out, "IFCMATERIAL"), 1, "{schema}");
        assert_eq!(count(&out, "IFCCLASSIFICATION"), 1, "{schema}: one system for every reference");
        assert_eq!(count(&out, "IFCCLASSIFICATIONREFERENCE"), 4, "{schema}: one shared and three own");
        let walls: Vec<u32> = (1..=3).map(|n| id_in(&out, gid(n))).collect();
        let material_rel = ids_of_type(&out, "IFCRELASSOCIATESMATERIAL");
        assert_eq!(material_rel.len(), 1, "{schema}");
        assert_eq!(attr(&out, schema, material_rel[0], "RelatedObjects"), format!("(#{},#{},#{})", walls[0], walls[1], walls[2]));
        assert_eq!(count(&out, "IFCRELASSOCIATESCLASSIFICATION"), 4, "{schema}: one per reference");
    }
}

#[test]
fn a_new_layer_set_mixes_new_and_existing_materials() {
    for schema in SCHEMAS {
        let source = associated_wall(schema);
        let mut w = wall(1);
        w.material = Some(MaterialLink::NewLayerSet(NewLayerSet {
            name: Some("Wall 300".into()),
            layers: vec![
                NewMaterialLayer { material: Some(LayerMaterial::Existing(ObjectRef::Id(200))), thickness: 0.2 },
                NewMaterialLayer { material: Some(LayerMaterial::New(concrete())), thickness: 0.08 },
                NewMaterialLayer { material: None, thickness: 0.02 },
            ],
        }));
        let (out, report) = run(&source, vec![add(w)]);
        assert_valid(&out, &report, schema);
        let set = ids_of_type(&out, "IFCMATERIALLAYERSET");
        assert_eq!(set.len(), 1, "{schema}");
        assert_eq!(attr(&out, schema, set[0], "LayerSetName"), "'Wall 300'");
        let layers = ids_of_type(&out, "IFCMATERIALLAYER");
        assert_eq!(attr(&out, schema, set[0], "MaterialLayers"), format!("(#{},#{},#{})", layers[0], layers[1], layers[2]));
        let new_material = *ids_of_type(&out, "IFCMATERIAL").last().unwrap();
        let got: Vec<(String, String)> =
            layers.iter().map(|&l| (attr(&out, schema, l, "Material"), attr(&out, schema, l, "LayerThickness"))).collect();
        let want = [("#200".to_string(), "0.2"), (format!("#{new_material}"), "0.08"), ("$".to_string(), "0.02")];
        assert_eq!(got, want.map(|(m, t)| (m, t.to_string())), "{schema}");
        // A new relationship: the source's names a different material.
        let rel = *ids_of_type(&out, "IFCRELASSOCIATESMATERIAL").last().unwrap();
        assert_eq!(attr(&out, schema, rel, "RelatingMaterial"), format!("#{}", set[0]));
    }
}

#[test]
fn values_carry_an_existing_or_a_new_unit_and_a_new_one_is_shared() {
    for schema in SCHEMAS {
        let source = associated_wall(schema);
        let kpa = || Some(ValueUnit::Si { prefix: Some("kilo".into()), name: "Pascal".into() });
        let mut a = wall(1);
        a.psets = vec![
            set(
                "Pset_Load",
                PsetKind::Property,
                vec![
                    measure("Existing", "IfcPressureMeasure", 3.0, Some(ValueUnit::Existing(ObjectRef::Id(220)))),
                    measure("New", "IfcPressureMeasure", 4.0, kpa()),
                    measure("Speed", "IfcLinearVelocityMeasure", 1.5, Some(ValueUnit::Existing(ObjectRef::Id(221)))),
                    measure("Plain", "IfcLengthMeasure", 2.0, None),
                ],
            ),
            set("Qto_Load", PsetKind::Quantity, vec![measure("Length", "IfcLengthMeasure", 4.5, Some(ValueUnit::Existing(ObjectRef::Id(51))))]),
        ];
        let mut b = wall(2);
        b.type_link = Some(TypeLink::New(NewType {
            global_id: None,
            class: ClassSpec { class: IfcClass::Named("IfcWallType".into()), predefined_type: None },
            name: Some("Load type".into()),
            psets: vec![set("Pset_TypeLoad", PsetKind::Property, vec![measure("New", "IfcPressureMeasure", 5.0, kpa())])],
            representation: Representation::None,
            style: None,
        }));
        let (out, report) = run(&source, vec![add(a), add(b)]);
        assert_valid(&out, &report, schema);
        let units = ids_of_type(&out, "IFCSIUNIT");
        assert_eq!(units.len(), 3, "{schema}: the project's metre, the source's kPa, one new kPa");
        let new_kpa = units[2];
        assert_eq!(attr(&out, schema, new_kpa, "Prefix"), ".KILO.");
        assert_eq!(attr(&out, schema, new_kpa, "UnitType"), ".PRESSUREUNIT.");
        let unit_of = |name: &str| {
            let id = ids_of_type(&out, "IFCPROPERTYSINGLEVALUE")
                .into_iter()
                .chain(ids_of_type(&out, "IFCQUANTITYLENGTH"))
                .filter(|&id| attr(&out, schema, id, "Name") == format!("'{name}'"))
                .collect::<Vec<_>>();
            id.iter().map(|&id| attr(&out, schema, id, "Unit")).collect::<Vec<_>>()
        };
        assert_eq!(unit_of("Existing"), ["#220"], "{schema}");
        assert_eq!(unit_of("New"), [format!("#{new_kpa}"), format!("#{new_kpa}")], "{schema}: shared by occurrence and type");
        assert_eq!(unit_of("Speed"), ["#221"], "{schema}");
        assert_eq!(unit_of("Plain"), ["$"], "{schema}");
        assert_eq!(unit_of("Length"), ["#51"], "{schema}");
    }
}

#[test]
fn a_unit_or_association_the_schema_cannot_hold_is_refused() {
    let with = |schema: &str, f: &dyn Fn(&mut NewObject)| {
        let mut w = wall(9);
        f(&mut w);
        refused(&associated_wall(schema), w)
    };
    let prop = |p: NewProperty| move |w: &mut NewObject| w.psets = vec![set("P", PsetKind::Property, vec![p.clone()])];
    let si = |prefix: Option<&str>, name: &str| Some(ValueUnit::Si { prefix: prefix.map(Into::into), name: name.into() });
    type Case = (&'static str, Box<dyn Fn(&mut NewObject)>, &'static str);
    let cases: Vec<Case> = vec![
        ("IFC4", Box::new(prop(NewProperty { name: "L".into(), value: PropertyValue::Label("x".into()), unit: si(None, "METRE") })), "needs a measure"),
        ("IFC4", Box::new(prop(measure("L", "IfcLengthMeasure", 1.0, si(Some("KILO"), "PASCAL")))), "does not measure"),
        ("IFC4", Box::new(prop(measure("L", "IfcLengthMeasure", 1.0, Some(ValueUnit::Existing(ObjectRef::Id(220)))))), "does not measure"),
        ("IFC4", Box::new(prop(measure("L", "IfcLengthMeasure", 1.0, si(None, "FURLONG")))), "not an IfcSIUnitName"),
        ("IFC4", Box::new(prop(measure("L", "IfcLengthMeasure", 1.0, si(Some("JUMBO"), "METRE")))), "not an IfcSIPrefix"),
        ("IFC4", Box::new(prop(measure("L", "IfcLengthMeasure", 1.0, Some(ValueUnit::Existing(ObjectRef::Id(10)))))), "not a unit"),
        (
            "IFC4",
            Box::new(|w: &mut NewObject| {
                let speed = measure("V", "IfcLengthMeasure", 1.0, Some(ValueUnit::Existing(ObjectRef::Id(221))));
                w.psets = vec![set("Q", PsetKind::Quantity, vec![speed])];
            }),
            "named unit",
        ),
        (
            "IFC4",
            Box::new(|w: &mut NewObject| {
                let user = measure("L", "IfcLengthMeasure", 1.0, Some(ValueUnit::Existing(ObjectRef::Id(223))));
                w.psets = vec![set("Q", PsetKind::Quantity, vec![user])];
            }),
            "does not measure",
        ),
        ("IFC4", Box::new(|w: &mut NewObject| w.material = Some(MaterialLink::Existing(ObjectRef::Id(10)))), "not a material"),
        (
            "IFC4",
            Box::new(|w: &mut NewObject| {
                w.class.class = IfcClass::Space;
                w.material = Some(MaterialLink::New(concrete()));
            }),
            "cannot carry a material",
        ),
        ("IFC4", Box::new(prop(measure("R", "IfcRatioMeasure", 0.5, Some(ValueUnit::Existing(ObjectRef::Id(225)))))), "does not measure"),
        (
            "IFC2X3",
            Box::new(|w: &mut NewObject| {
                w.class.class = IfcClass::Named("IfcOpeningElement".into());
                w.material = Some(MaterialLink::New(concrete()));
            }),
            "cannot carry a material",
        ),
        (
            "IFC4",
            Box::new(|w: &mut NewObject| {
                let r = NewClassificationReference { system: uniclass(), identification: None, name: None, location: None };
                w.classifications = vec![ClassificationLink::New(r)];
            }),
            "needs an identification",
        ),
        ("IFC4", Box::new(|w: &mut NewObject| w.material = Some(MaterialLink::Existing(ObjectRef::Id(999)))), "not found"),
        ("IFC4", Box::new(|w: &mut NewObject| w.material = Some(MaterialLink::New(NewMaterial { name: String::new(), category: None }))), "needs a name"),
        (
            "IFC2X3",
            Box::new(|w: &mut NewObject| w.material = Some(MaterialLink::New(NewMaterial { name: "C".into(), category: Some("concrete".into()) }))),
            "no Category",
        ),
        ("IFC4", Box::new(|w: &mut NewObject| w.material = Some(MaterialLink::NewLayerSet(NewLayerSet { name: None, layers: Vec::new() }))), "at least one layer"),
        (
            "IFC2X3",
            Box::new(|w: &mut NewObject| {
                let layers = vec![NewMaterialLayer { material: None, thickness: 0.0 }];
                w.material = Some(MaterialLink::NewLayerSet(NewLayerSet { name: None, layers }));
            }),
            "thickness",
        ),
        (
            "IFC4",
            Box::new(|w: &mut NewObject| {
                let layers = vec![NewMaterialLayer { material: Some(LayerMaterial::Existing(ObjectRef::Id(201))), thickness: 0.1 }];
                w.material = Some(MaterialLink::NewLayerSet(NewLayerSet { name: None, layers }));
            }),
            "not an IFCMATERIAL",
        ),
        ("IFC4", Box::new(|w: &mut NewObject| w.classifications = vec![reference("A"), reference("A")]), "appears twice"),
        ("IFC4", Box::new(|w: &mut NewObject| w.classifications = vec![ClassificationLink::Existing(ObjectRef::Id(200))]), "not a classification"),
        ("IFC2X3", Box::new(|w: &mut NewObject| w.classifications = vec![ClassificationLink::Existing(ObjectRef::Id(210))]), "not a classification"),
        (
            "IFC2X3",
            Box::new(|w: &mut NewObject| {
                let system = ClassificationSystem::New(NewClassification { name: "U".into(), source: None, edition: None });
                let r = NewClassificationReference { system, identification: None, name: None, location: None };
                w.classifications = vec![ClassificationLink::New(r)];
            }),
            "Source and Edition",
        ),
    ];
    for (schema, f, expected) in cases {
        let reason = with(schema, &*f);
        assert!(reason.contains(expected), "{schema}: expected {expected:?}, got {reason:?}");
    }
    // What IFC2X3 refuses, IFC4 holds: a zero-thickness layer, a material
    // category, a classification system as the relating classification.
    let mut w = wall(9);
    w.material = Some(MaterialLink::NewLayerSet(NewLayerSet { name: None, layers: vec![NewMaterialLayer { material: None, thickness: 0.0 }] }));
    w.classifications = vec![ClassificationLink::Existing(ObjectRef::Id(210))];
    // A property, unlike a quantity, may carry a user-defined unit; a
    // context-dependent measure takes a context-dependent unit.
    let user = Some(ValueUnit::Existing(ObjectRef::Id(223)));
    w.psets = vec![set(
        "P",
        PsetKind::Property,
        vec![measure("L", "IfcLengthMeasure", 1.0, user.clone()), measure("C", "IfcContextDependentMeasure", 2.0, user)],
    )];
    // A structural member takes a material too.
    let mut member = wall(10);
    member.class = ClassSpec { class: IfcClass::Named("IfcStructuralSurfaceMember".into()), predefined_type: Some("SHELL".into()) };
    member.material = Some(MaterialLink::Existing(ObjectRef::Id(200)));
    let mut port = object(IfcClass::Named("IfcDistributionPort".into()), gid(11), None, Representation::None);
    port.material = Some(MaterialLink::Existing(ObjectRef::Id(200)));
    let (out, report) = run(&associated_wall("IFC4"), vec![add(w), add(member), add(port)]);
    assert_valid(&out, &report, "IFC4");
    assert_eq!(report.added, 3);

    // IFC2X3 takes a material on any product but an opening or virtual
    // element, a space included.
    let mut space = object(IfcClass::Space, gid(12), Some(ObjectRef::Id(70)), Representation::None);
    space.material = Some(MaterialLink::Existing(ObjectRef::Id(200)));
    let (out, report) = run(&associated_wall("IFC2X3"), vec![add(space)]);
    assert_valid(&out, &report, "IFC2X3");
    assert_eq!(report.added, 1);
}

/// A new material an Add built and then lost (the Add was refused) is not
/// what a later Add naming the same material reuses: that one writes its own.
#[test]
fn a_refused_add_shares_nothing_it_built() {
    for schema in SCHEMAS {
        let ok = || {
            let mut w = object(IfcClass::Wall, gid(2), Some(ObjectRef::Id(70)), Representation::None);
            w.material = Some(MaterialLink::New(concrete()));
            w
        };
        // How many ids `ok` needs, relationships included.
        let roomy = crate::plan::test_fixtures::storey_with_headroom(schema, 1000);
        let (out, report) = run(&roomy, vec![add(ok())]);
        assert_clean(&report, schema);
        let used = FileIndex::scan(&out, &Default::default()).records().filter(|&(id, _, _, _)| id > u32::MAX - 1000).count() as u32;

        // The same object plus three new classification systems runs out of
        // ids after building its material, and is refused.
        let mut greedy = ok();
        greedy.global_id = gid(1);
        greedy.classifications = (0..3)
            .map(|n| {
                let system = NewClassification { name: format!("S{n}"), source: Some("s".into()), edition: Some("1".into()) };
                let r = NewClassificationReference { system: ClassificationSystem::New(system), identification: Some("X".into()), name: None, location: None };
                ClassificationLink::New(r)
            })
            .collect();
        let tight = crate::plan::test_fixtures::storey_with_headroom(schema, used);
        let (out, report) = run(&tight, vec![add(greedy), add(ok())]);
        assert_eq!(report.added, 1, "{schema}: {:?}", report.refusals);
        assert_eq!(report.refusals.len(), 1, "{schema}");
        assert!(report.refusals[0].reason.contains("id space exhausted"), "{schema}: {:?}", report.refusals);
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}: {:?}", crate::plan::validate::validate(&out, schema));
        assert_eq!(count(&out, "IFCMATERIAL"), 1, "{schema}");
    }
}

/// Deleting the only object a material, classification and unit served does
/// not take them from an Add in the same plan that names them.
#[test]
fn a_delete_in_the_same_plan_keeps_what_an_add_names() {
    for schema in SCHEMAS {
        let source = associated_wall(schema);
        let mut copy = wall(1);
        copy.material = Some(MaterialLink::Existing(ObjectRef::Id(200)));
        copy.classifications = vec![ClassificationLink::Existing(ObjectRef::Id(211))];
        copy.psets = vec![set("P", PsetKind::Property, vec![measure("Load", "IfcPressureMeasure", 1.0, Some(ValueUnit::Existing(ObjectRef::Id(220))))])];
        let (out, report) = run(&source, vec![(ObjectRef::Id(10), Disposition::Delete), add(copy)]);
        assert_valid(&out, &report, schema);
        assert_eq!(report.added, 1, "{schema}");
        let copy = id_in(&out, gid(1));
        let rels = ids_of_type(&out, "IFCRELASSOCIATESMATERIAL");
        assert_eq!(rels.len(), 1, "{schema}");
        assert_eq!(attr(&out, schema, rels[0], "RelatedObjects"), format!("(#{copy})"), "{schema}");
        assert_eq!(attr(&out, schema, rels[0], "RelatingMaterial"), "#200", "{schema}");
        assert_eq!(count(&out, "IFCCLASSIFICATIONREFERENCE"), 1, "{schema}");
    }
}
