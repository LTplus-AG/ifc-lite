// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8341 C4-13a: `Features::finishes` raises `on_finishes` before every
//! `on_batch`, and each entry is exactly what `ModelFinishes::from_content`
//! (the server's former second read of the file) joins for that mesh. Off by
//! default, the event never fires and the meshes are the ones the feature-on
//! pass emits.

use ifc_lite_processing::style::{ModelFinishes, SpecularMaterial};
use ifc_lite_processing::{process, Batching, MeshData, ProcessingRequest, ProcessingSink};

type Finishes = Vec<Option<SpecularMaterial>>;

/// Every batch with the finishes announced just before it.
#[derive(Default)]
struct Recorder {
    pending: Option<Finishes>,
    events: usize,
    batches: Vec<(Vec<MeshData>, Option<Finishes>)>,
}

impl ProcessingSink for Recorder {
    fn on_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        assert!(self.pending.is_none(), "on_finishes fired twice before one on_batch");
        self.events += 1;
        self.pending = Some(finishes.to_vec());
    }

    fn on_batch(&mut self, meshes: &[MeshData], _processed: usize, _total: usize) {
        let finishes = self.pending.take();
        if let Some(finishes) = &finishes {
            assert_eq!(finishes.len(), meshes.len(), "one finish per mesh of the batch");
        }
        self.batches.push((meshes.to_vec(), finishes));
    }
}

fn with_finishes(request: ProcessingRequest) -> ProcessingRequest {
    let features = request.features.finishes(true);
    request.features(features)
}

/// What the server joined before #8341: a second scan of `content`.
fn rescan_join(content: &[u8], meshes: &[MeshData]) -> Finishes {
    let mut finishes = ModelFinishes::from_content(content);
    meshes.iter().map(|mesh| finishes.finish_for_mesh(mesh)).collect()
}

fn wire(meshes: &[MeshData]) -> Vec<u8> {
    serde_json::to_vec(meshes).unwrap()
}

/// Run every shape of the check on `content` and return how many meshes carry
/// an authored finish, so a caller can assert the fixture exercised one.
fn check(content: &[u8], what: &str) -> usize {
    // Default: no event, and the reference meshes.
    let mut off = Recorder::default();
    let baseline = process(content, &ProcessingRequest::full_pass(), &mut off);
    assert_eq!(off.events, 0, "{what}: on_finishes fired with the feature off");
    let expected = rescan_join(content, &baseline.meshes);

    // The full-pass routes' shape: one chunk, meshes read off the result.
    let mut full = Recorder::default();
    let result = process(content, &with_finishes(ProcessingRequest::full_pass()), &mut full);
    assert_eq!(wire(&result.meshes), wire(&baseline.meshes), "{what}: the feature changed the meshes");
    assert_eq!(full.events, full.batches.len(), "{what}: one on_finishes per on_batch");
    let joined: Finishes = full.batches.into_iter().flat_map(|(_, f)| f.expect("announced")).collect();
    assert_eq!(joined, expected, "{what}: full pass finishes differ from the rescan join");

    // The SSE shape: small chunks, meshes not retained, each batch joined alone.
    let request = with_finishes(ProcessingRequest::default().batching(Batching::new(3, 17)).retain_meshes(false));
    let mut streamed = Recorder::default();
    process(content, &request, &mut streamed);
    let mut rescan = ModelFinishes::from_content(content);
    let mut streamed_meshes = Vec::new();
    for (meshes, finishes) in streamed.batches {
        let reference: Finishes = meshes.iter().map(|mesh| rescan.finish_for_mesh(mesh)).collect();
        assert_eq!(finishes.expect("announced"), reference, "{what}: a streamed batch's finishes differ");
        streamed_meshes.extend(meshes);
    }
    assert_eq!(wire(&streamed_meshes), wire(&baseline.meshes), "{what}: streamed meshes differ");

    expected.iter().filter(|f| f.is_some()).count()
}

/// `IFCSURFACESTYLERENDERING` with `SpecularColour = 0.75` -> roughness 0.25,
/// on a #957 type map (no item id) and on an occurrence's styled
/// `IfcMappedItem`: the two element-level reaches of the join.
const SYNTHETIC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-8341'),'2;1');
FILE_NAME('t.ifc','2026-10-30T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A',$,'Boiler',$,$,$,(#44),$,$,.NOTDEFINED.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#50=IFCSTYLEDITEM(#48,(#52),$);
#52=IFCSURFACESTYLE($,.POSITIVE.,(#54));
#54=IFCSURFACESTYLERENDERING(#56,$,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);
#56=IFCCOLOURRGB($,0.6,0.5,0.4);
#57=IFCBOILERTYPE('3n5ASfQfT84eP9h$zLLJ4A',$,'Boiler2',$,$,$,(#58),$,$,.NOTDEFINED.);
#58=IFCREPRESENTATIONMAP(#45,#59);
#59=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#60));
#60=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4)),$);
#100=IFCBUILDINGELEMENTPROXY('1occurrenceMapped0000',$,'Occ',$,$,#101,#102,$,.NOTDEFINED.);
#101=IFCLOCALPLACEMENT($,#5);
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#104));
#104=IFCMAPPEDITEM(#58,#105);
#105=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
#110=IFCSTYLEDITEM(#104,(#52),$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn finishes_event_matches_the_rescan_join_on_synthetic_reaches_8341() {
    assert!(check(SYNTHETIC.as_bytes(), "synthetic") >= 2, "both reaches carry the glossy finish");
}

#[test]
fn finishes_event_on_a_file_without_finishes_announces_none_8341() {
    let plain = SYNTHETIC.replace("IFCNORMALISEDRATIOMEASURE(0.75)", "$");
    assert_eq!(check(plain.as_bytes(), "no finish"), 0);
}

/// Real authoring-tool files: ArchiCAD (FZK-Haus, SpecularColour factor),
/// Revit (rvt01, duplex, Office_A: SpecularColour + SpecularExponent),
/// BIMcollab, a mapped-item-heavy CSG model, and one with no finish at all.
const FIXTURES: &[&str] = &[
    "ara3d/AC20-FZK-Haus.ifc",
    "ara3d/duplex.ifc",
    "ara3d/Office_A_20110811.ifc",
    "various/rvt01.ifc",
    "various/02_BIMcollab_Example_STR_random_C_ebkp.ifc",
    "issues/218_IFC-test-lite.ifc",
    "ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc",
    "ara3d/IfcOpenHouse_IFC4.ifc",
];

#[test]
fn finishes_event_matches_the_rescan_join_on_real_fixtures_8341() {
    for rel in FIXTURES {
        let Some(content) = ifc_lite_testkit::fixture_bytes(rel) else {
            eprintln!("skip {rel}: absent (run `pnpm fixtures`)");
            continue;
        };
        let finished = check(&content, rel);
        eprintln!("{rel}: {finished} meshes carry an authored finish");
        if *rel == "ara3d/AC20-FZK-Haus.ifc" {
            assert!(finished > 0, "FZK-Haus authors finishes (#5984 acceptance)");
        }
    }
}
