// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M11-F on the real SMLib kernel: persistent face keys meet the source
//! oracle (keys and per-key areas), hand-derived reveal areas, kernel
//! cross-check refusal, and the native reference for browser parity.
mod support;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{
    run_model, AsyncRetainedExecutor, Invocation, NumericalLimits, NumericalReceipt, Operand, ProductOutcome,
    ReceiptEvidence, ReceiptMesh, RetainedRuntime, RuntimeFault, ShapeOnlyProduct,
};
use ifc_lite_retained_native::{block_on, oracle::{face_bands, faces::{self, FaceAreas}}, NativeDomain, NativeReceipt, NativeWorker};
use std::collections::{BTreeMap, BTreeSet};
use support::{native, shape, worker_path};

#[path = "../examples/compare/tolerances.rs"]
mod tolerances;
#[allow(dead_code)]
#[path = "../examples/compare/checks/faces.rs"]
mod face_check;
#[allow(dead_code)]
#[derive(Default)]
pub struct OracleResult { pub family: &'static str, pub value: f64, pub limit: f64, pub pass: bool, pub gated: bool }

fn fixture(path: &str) -> String { std::fs::read_to_string(format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap() }
fn limit(curved: bool) -> f64 {
    tolerances::registered().unwrap()["faceAreaRelative"][if curved { "curved" } else { "linear" }].as_f64().unwrap()
}
/// Keys and per-key areas equal the source oracle within the preregistered bounds.
fn assert_matches(label: &str, product: &ShapeOnlyProduct, expected: &FaceAreas) -> BTreeMap<String, f64> {
    let actual = face_check::measured(product).unwrap_or_else(|| panic!("{label}: unkeyed triangles"));
    assert_eq!(actual.keys().collect::<BTreeSet<_>>(), expected.keys().collect::<BTreeSet<_>>(), "{label}: key set");
    for (key, e) in expected {
        let relative = (actual[key] - e.area_m2).abs() / e.area_m2;
        assert!(relative <= limit(e.curved), "{label} {key}: {} vs {} ({relative:e})", actual[key], e.area_m2);
    }
    actual
}
fn sources(text: &str) -> ifc_lite_processing::AnalyticQuantitySources {
    ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None)
}

#[test]
fn issue_7955_m11_f_uncut_box_disk_and_mapped_keys_match_source() {
    for (path, ids) in [("tests/fixtures/synthetic-retained/f-c-extrusion.ifc", None),
        ("rust/geometry/tests/fixtures/swept_disk_trimmed_line.ifc", Some(vec![50u32])),
        ("rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc", None)] {
        let text = fixture(path);
        let Some(outcomes) = native(&text) else { return; };
        let sources = sources(&text);
        let mut key_sets = BTreeSet::new();
        for outcome in &outcomes {
            let ProductOutcome::Published(product) = outcome else { panic!("{path}: {outcome:?}") };
            if ids.as_ref().is_some_and(|ids| !ids.contains(&product.product_id)) { continue; }
            let expected = faces::uncut(&sources, product.product_id).unwrap();
            key_sets.insert(assert_matches(path, product, &expected).into_keys().collect::<Vec<_>>());
        }
        // Every occurrence of one mapped item carries the same persistent keys.
        assert_eq!(key_sets.len(), 1, "{path}: {key_sets:?}");
    }
    let disk = fixture("rust/geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
    let outcomes = native(&disk).unwrap();
    let keys: Vec<_> = shape(&outcomes, 50).parts[0].faces.as_ref().unwrap().table.iter().map(ToString::to_string).collect();
    assert_eq!(keys, ["#43:disk(wall)", "#43:disk(start)", "#43:disk(end)"]);
    println!("sdk witness executed: m11_f_uncut");
}

#[test]
fn issue_7955_m11_f_curved_reveals_match_hand_derived_areas() {
    let text = fixture("tests/fixtures/synthetic-retained/f-a-curved.ifc");
    let Some(outcomes) = native(&text) else { return; };
    let sources = sources(&text);
    // Door box x 9..12, |y| <= 0.5, z 0..2 through a quarter annulus a..b: jambs on y = ±0.5
    // span sqrt(b²-¼) - sqrt(a²-¼) for 2 m; the lintel is the strip ∫|y|≤½ (√(b²-y²) - √(a²-y²)) dy.
    let strip = |r: f64| 0.5 * (r * r - 0.25f64).sqrt() + r * r * (0.5 / r).asin();
    for (host, item, opening, a, b) in [(122u32, 126u32, 129u32, 10., 10.1), (188, 192, 195, 10.1, 10.3), (254, 258, 261, 10.3, 10.6)] {
        let product = shape(&outcomes, host);
        let actual = assert_matches(&format!("#{host}"), product, &face_bands::cut(&sources, host, &[opening]).unwrap());
        let jamb = 2. * ((b * b - 0.25f64).sqrt() - (a * a - 0.25f64).sqrt());
        for (role, expected) in [("side(0,0)", jamb), ("side(0,2)", jamb), ("cap(end)", strip(b) - strip(a))] {
            let key = format!("#{item}>#{opening}:{role}");
            let measured = *actual.get(&key).unwrap_or_else(|| panic!("#{host}: missing {key} in {actual:?}"));
            assert!((measured - expected).abs() / expected <= limit(true), "#{host} {key}: {measured} vs {expected}");
        }
    }
    println!("sdk witness executed: m11_f_curved_reveals");
}

#[test]
fn issue_7955_m11_f_overlapping_openings_follow_the_prism_bands() {
    let text = fixture("rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
    let Some(outcomes) = native(&text) else { return; };
    let expected = face_bands::cut(&sources(&text), 30, &[50, 70, 100]).unwrap();
    assert_matches("issue_2019 #30", shape(&outcomes, 30), &expected);
    println!("sdk witness executed: m11_f_bands");
}

/// Hand-built FZK equivalent: one opening #50 of two abutting boxes (A #46 then B #56, split at
/// y = 0.15 across the 0.3 m wall #30), so their jambs and sill/head caps are coplanar and connected.
const ABUTTING: &str = "ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m11-f-abutting','2026-10-28T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCDIRECTION((1.,0.,0.));#4=IFCDIRECTION((0.,0.,1.));
#5=IFCAXIS2PLACEMENT3D(#1,#4,#2);#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#7=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#6,$,.MODEL_VIEW.,$);#8=IFCLOCALPLACEMENT($,#5);
#20=IFCCARTESIANPOINT((0.,0.));#21=IFCCARTESIANPOINT((4.,0.));#22=IFCCARTESIANPOINT((4.,0.3));#23=IFCCARTESIANPOINT((0.,0.3));
#24=IFCPOLYLINE((#20,#21,#22,#23,#20));#25=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'Wall',#24);
#26=IFCEXTRUDEDAREASOLID(#25,#5,#4,3.);#27=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));#29=IFCLOCALPLACEMENT(#8,#5);
#30=IFCWALL('0000000000000000000W1',$,'Wall',$,$,#29,#28,$);
#40=IFCCARTESIANPOINT((1.,-0.1));#41=IFCCARTESIANPOINT((2.,-0.1));#42=IFCCARTESIANPOINT((2.,0.15));#43=IFCCARTESIANPOINT((1.,0.15));
#44=IFCPOLYLINE((#40,#41,#42,#43,#40));#45=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'A',#44);
#47=IFCCARTESIANPOINT((0.,0.,0.5));#48=IFCAXIS2PLACEMENT3D(#47,#4,#2);#46=IFCEXTRUDEDAREASOLID(#45,#48,#4,2.);
#51=IFCCARTESIANPOINT((1.,0.4));#52=IFCCARTESIANPOINT((2.,0.4));
#54=IFCPOLYLINE((#43,#42,#52,#51,#43));#55=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'B',#54);
#56=IFCEXTRUDEDAREASOLID(#55,#48,#4,2.);
#57=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#46,#56));#58=IFCPRODUCTDEFINITIONSHAPE($,$,(#57));
#59=IFCLOCALPLACEMENT(#8,#5);#50=IFCOPENINGELEMENT('0000000000000000000A1',$,'Door',$,$,#59,#58,$);
#80=IFCRELVOIDSELEMENT('0000000000000000000R1',$,$,$,#30,#50);
ENDSEC;END-ISO-10303-21;";
/// Hand-derived: each jamb is one 0.3 m x 2 m face, each sill/head one 1 m x 0.3 m face, all on A.
fn abutting_hand_keys() -> BTreeMap<String, f64> {
    BTreeMap::from([("#26:side(0,0)", 10.), ("#26:side(0,2)", 10.), ("#26:side(0,1)", 0.9), ("#26:side(0,3)", 0.9),
        ("#26:cap(start)", 1.2), ("#26:cap(end)", 1.2), ("#46>#50:side(0,1)", 0.6), ("#46>#50:side(0,3)", 0.6),
        ("#46>#50:cap(start)", 0.3), ("#46>#50:cap(end)", 0.3)].map(|(k, v)| (k.to_owned(), v)))
}

#[test]
fn issue_7955_m11_f_connected_coincident_faces_go_to_the_earliest_cut_oracle() {
    let expected = face_bands::cut(&sources(ABUTTING), 30, &[50]).expect("abutting cutters are predicted");
    let hand = abutting_hand_keys();
    assert_eq!(expected.keys().collect::<Vec<_>>(), hand.keys().collect::<Vec<_>>(), "B #56 keeps no face");
    for (key, area) in &hand { assert!((expected[key].area_m2 - area).abs() <= 1e-12, "{key}: {:?}", expected[key]); }
}

#[test]
fn issue_7955_m11_f_connected_coincident_faces_go_to_the_earliest_cut() {
    let Some(outcomes) = native(ABUTTING) else { return; };
    // Gated on the real kernel: a kernel splitting the jamb or sill per box keys B #56 and fails here.
    let actual = assert_matches("abutting #30", shape(&outcomes, 30), &face_bands::cut(&sources(ABUTTING), 30, &[50]).unwrap());
    for (key, area) in abutting_hand_keys() {
        assert!((actual[&key] - area).abs() / area <= limit(false), "{key}: {} vs {area}", actual[&key]);
    }
    println!("sdk witness executed: m11_f_connected_coincident");
}

/// Shared M11 fixture f-i (#8268): every published case meets the source oracle; (d) also
/// meets the README's hand-derived arc-wall areas. (e) and (f) refuse upstream on main.
#[test]
fn issue_7955_m11_f_presentation_fixture_faces() {
    let text = fixture("tests/fixtures/synthetic-retained/f-i-presentation.ifc");
    let Some(outcomes) = native(&text) else { return; };
    let sources = sources(&text);
    let mut mapped = BTreeSet::new();
    for outcome in &outcomes {
        let ProductOutcome::Published(product) = outcome else { continue };
        let expected = if product.product_id == 425 { face_bands::cut(&sources, 425, &[433]) } else { faces::uncut(&sources, product.product_id) };
        let actual = assert_matches(&format!("f-i #{}", product.product_id), product, &expected.expect("predicted"));
        if (311..=391).contains(&product.product_id) { mapped.insert(actual.into_keys().collect::<Vec<_>>()); }
    }
    assert_eq!(mapped.len(), 1, "(c) nine occurrences of one map share their keys: {mapped:?}");
    // (d), README: annulus r 5.0..5.3 over 90 deg, height 3, box opening x 4.5..5.75, |y| <= 0.5, z 0.5..2.5.
    let actual = face_check::measured(shape(&outcomes, 425)).unwrap();
    for (key, area, curved) in [("#421:side(0,0)", 22.972682996507, true), ("#421:side(0,2)", 21.558596478692, true),
        ("#421:side(0,1)", 0.9, false), ("#421:side(0,3)", 0.9, false), ("#421:cap(start)", 2.426880324898, true),
        ("#421:cap(end)", 2.426880324898, true), ("#440>#433:side(0,0)", 0.602850395552, false),
        ("#440>#433:side(0,2)", 0.602850395552, false), ("#440>#433:cap(start)", 0.300473714228, true),
        ("#440>#433:cap(end)", 0.300473714228, true)] {
        let measured = *actual.get(key).unwrap_or_else(|| panic!("(d) missing {key}: {actual:?}"));
        assert!((measured - area).abs() / area <= limit(curved), "(d) {key}: {measured} vs {area}");
    }
    assert_eq!(actual.len(), 10, "(d) no other keys: {actual:?}");
    // Not reachable on main: (e) the bent swept disk, (f) the halfspace clip (its tie-break needs M5/M6).
    for (id, entity) in [(507, 504), (610, 607)] {
        let refused = outcomes.iter().find_map(|o| match o {
            ProductOutcome::Refused { product_id, refusal, origin, .. } if *product_id == id => Some((refusal.code(), origin.and_then(|o| o.entity))),
            _ => None,
        });
        assert_eq!(refused, Some(("operation_unsupported", Some(entity))), "f-i #{id} became reachable: add its face case");
    }
    println!("sdk witness executed: m11_f_presentation_fixture");
}

// A real receipt whose one Boolean triangle claims another kernel face: the kernel
// cross-check must refuse, never re-key or publish.
struct Corrupt(NativeReceipt, Option<Vec<u32>>);
impl NumericalReceipt for Corrupt {
    type Object = <NativeReceipt as NumericalReceipt>::Object;
    type Domain = NativeDomain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 { NativeReceipt::heap_bytes() }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> { self.0.buffer_bytes() }
    fn mesh(&self) -> Option<ReceiptMesh<'_>> {
        self.0.mesh().map(|m| ReceiptMesh { faces: self.1.as_deref().unwrap_or(m.faces), ..m })
    }
    fn object(&self) -> Self::Object { self.0.object() }
    fn evidence(&self) -> ReceiptEvidence<'_, Self::Object> { self.0.evidence() }
    fn domain(&self) -> &NativeDomain { self.0.domain() }
    fn validate_live(&self) -> Result<(), RuntimeFault> { self.0.validate_live() }
}
fn unwrap(operand: Operand<'_, Corrupt>) -> Operand<'_, NativeReceipt> {
    match operand {
        Operand::Source { receipt, world_from_source } => Operand::Source { receipt: &receipt.0, world_from_source },
        Operand::Placed { receipt, world_from_object } => Operand::Placed { receipt: &receipt.0, world_from_object },
    }
}
struct CorruptWorker(NativeWorker);
impl RetainedRuntime for CorruptWorker {
    type Receipt = Corrupt;
    fn domain(&self) -> NativeDomain { self.0.domain() }
    fn incarnation(&self) -> u64 { self.0.incarnation() }
}
impl AsyncRetainedExecutor for CorruptWorker {
    async fn invoke(&mut self, call: Invocation<'_, Corrupt>, limits: NumericalLimits) -> Result<Corrupt, RuntimeFault> {
        let (call, boolean) = match call {
            Invocation::Construction(request) => (Invocation::Construction(request), false),
            Invocation::Affine { input, column_major } => (Invocation::Affine { input: &input.0, column_major }, false),
            Invocation::Boolean { left, right, operation } =>
                (Invocation::Boolean { left: unwrap(left), right: unwrap(right), operation }, true),
        };
        let receipt = self.0.invoke(call, limits).await?;
        let faces = boolean.then(|| receipt.mesh()).flatten().map(|m| {
            // Give triangle 0 the face of the first triangle facing elsewhere.
            let normal = |t: usize| {
                let p = |c: usize| { let i = m.indices[t * 3 + c] as usize * 3; [m.positions[i], m.positions[i + 1], m.positions[i + 2]] };
                let (a, b, c) = (p(0), p(1), p(2));
                let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
                [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
            };
            let n0 = normal(0);
            let other = (1..m.faces.len()).find(|&t| { let n = normal(t); n0[0] * n[0] + n0[1] * n[1] + n0[2] * n[2] < 0. }).unwrap();
            let mut faces = m.faces.to_vec();
            faces[0] = faces[other];
            faces
        });
        Ok(Corrupt(receipt, faces))
    }
}
#[test]
fn issue_7955_m11_f_corrupted_kernel_face_refuses_face_provenance_unproven() {
    let Some(path) = worker_path() else { eprintln!("SKIP: set IFCLITE_SMLIB_WORKER"); return; };
    let text = fixture("rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
    let mut outcomes = Vec::new();
    block_on(run_model(SourceBundle::new(text.into_bytes()), &Default::default(),
        || NativeWorker::spawn(&path).map(CorruptWorker), |o| outcomes.push(o))).unwrap();
    let refused = outcomes.iter().find_map(|o| match o {
        ProductOutcome::Refused { product_id: 30, refusal, origin, .. } => Some((refusal.code(), origin.map(|o| (o.site, o.cause)))),
        _ => None,
    });
    assert_eq!(refused, Some(("face_provenance_unproven", Some(("faces", "ambiguous")))), "{outcomes:?}");
    // Its own openings still publish: the refusal is product-atomic.
    assert!(outcomes.iter().any(|o| matches!(o, ProductOutcome::Published(p) if p.product_id == 50)));
    println!("sdk witness executed: m11_f_kernel_cross_check");
}

/// Browser parity reference: every published product's keys with their triangle counts and areas.
#[test]
fn issue_7955_m11_f_stage_native_browser_reference() {
    let mut models = BTreeMap::new();
    for path in ["tests/fixtures/synthetic-retained/f-a-curved.ifc",
        "rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc",
        "rust/geometry/tests/fixtures/swept_disk_trimmed_line.ifc", "tests/fixtures/synthetic-retained/f-i-presentation.ifc"] {
        let Some(outcomes) = native(&fixture(path)) else { return; };
        let rows: Vec<_> = outcomes.iter().map(|o| match o {
            ProductOutcome::Published(p) => {
                let areas = face_check::measured(p).unwrap();
                let mut triangles: BTreeMap<String, usize> = BTreeMap::new();
                for faces in p.parts.iter().map(|part| part.faces.as_ref().unwrap()) {
                    for &k in &faces.triangles { *triangles.entry(faces.table[k as usize].to_string()).or_default() += 1; }
                }
                let faces: BTreeMap<_, _> = areas.iter().map(|(k, a)| (k.clone(), serde_json::json!({"triangles": triangles[k], "area": a}))).collect();
                serde_json::json!({"id": p.product_id, "code": "published", "keys": areas.keys().collect::<Vec<_>>(), "faces": faces})
            }
            ProductOutcome::Refused { product_id, refusal, .. } => serde_json::json!({"id": product_id, "code": refusal.code()}),
        }).collect();
        models.insert(path.rsplit('/').next().unwrap().to_owned(), rows);
    }
    if let Some(path) = std::env::var_os("IFCLITE_M11F_REFERENCE") {
        std::fs::write(path, serde_json::to_vec_pretty(&models).unwrap()).unwrap();
    }
    println!("sdk witness executed: m11_f_reference");
}

