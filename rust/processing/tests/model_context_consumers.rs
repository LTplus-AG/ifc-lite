// SPDX-License-Identifier: MPL-2.0
//! Chunk snapshots must retain the established deferred-style event boundary.
use ifc_lite_processing::{process, process_geometry, Batching, Features, MeshData,
    ProcessingRequest, ProcessingSink};

#[derive(Debug)]
enum Event { Batch(Vec<(u32, [f32; 4], usize)>, usize), Colors(Vec<(u32, [f32; 4])>) }
#[derive(Default)]
struct Sink(Vec<Event>);
impl ProcessingSink for Sink {
    fn on_batch(&mut self, meshes: &[MeshData], processed: usize, _: usize) {
        self.0.push(Event::Batch(meshes.iter().map(|m|
            (m.express_id, m.color, m.indices.len() / 3)).collect(), processed));
    }
    fn on_color_update(&mut self, updates: &[(u32, [f32; 4])]) {
        self.0.push(Event::Colors(updates.to_vec()));
    }
}

#[test]
fn native_snapshots_follow_first_nonempty_chunk_and_deferred_style_replacement() {
    let source = include_str!("fixtures/issue_6601_multicolor_element.ifc")
        .replace("#23=IFCBUILDINGELEMENTPROXY", "#101=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',());\n#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#101));\n#100=IFCBUILDINGELEMENTPROXY('empty',$,'empty',$,$,#22,#102,$,$);\n#23=IFCBUILDINGELEMENTPROXY")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#200=IFCBUILDINGELEMENTPROXY('later',$,'later',$,$,#22,#19,$,$);\nENDSEC;\nEND-ISO-10303-21;");
    let request = ProcessingRequest::default().batching(Batching::new(1, 1).fast_first(true))
        .features(Features::default().presentation_layers(false));
    let mut sink = Sink::default();
    let result = process(source.as_bytes(), &request, &mut sink);
    assert_eq!(result.meshes.len(), 4);
    let [Event::Batch(first_a, processed_a), Event::Batch(first_b, processed_b),
        Event::Colors(updates), Event::Batch(later_a, total_a), Event::Batch(later_b, total_b)] = sink.0.as_slice()
        else { panic!("unexpected deferred-style trace: {:?}", sink.0) };
    // Batch size bounds emitted meshes as well as input jobs. Both meshes from
    // the first nonempty input chunk precede its deferred style replacement.
    assert_eq!((*processed_a, *processed_b, *total_a, *total_b), (2, 2, 3, 3),
        "empty first chunk must not publish or replay styles");
    assert!([first_a, first_b, later_a, later_b].iter().all(|batch| batch.len() == 1));
    let first: Vec<_> = first_a.iter().chain(first_b).copied().collect();
    let later: Vec<_> = later_a.iter().chain(later_b).copied().collect();
    assert_eq!(first.len(), 2);
    assert!(first.iter().all(|&(id, color, tris)| id == 23 && color == [0.6, 0.6, 0.6, 1.] && tris > 0));
    assert_eq!(updates, &vec![(23, [1., 0., 0., 1.])]);
    assert_eq!(later.len(), 2);
    let eager = process_geometry(&source);
    let expected: Vec<_> = eager.meshes.iter().filter(|m| m.express_id == 200)
        .map(|m| (m.express_id, m.color, m.indices.len() / 3)).collect();
    assert_eq!(later, expected, "new chunk must use the replaced style Arc");
    assert_eq!(later[0].1, [1., 0., 0., 1.]);
    assert_eq!(later[1].1, [0., 1., 0., 0.25]);
}
