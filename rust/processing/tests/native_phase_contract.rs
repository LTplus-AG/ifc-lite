// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-4b (#7782): sink cancellation bounds the pass before the next chunk.
mod common;
use common::entry_trace::{assert_ordering_contract, Event, Recorder};
use ifc_lite_processing::{process, Batching, ProcessingRequest};
use std::sync::Arc;

fn load(rel: &str) -> Vec<u8> {
    let path = format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// #7782: cancellation raised by a real sink must stop the next chunk,
/// preserving the already-published geometry with either retention policy.
#[test]
fn issue_7782_sink_cancellation_keeps_only_the_completed_chunk() {
    use ifc_lite_processing::{MeshData, ProcessingSink};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct CancelAfterBatch {
        recorder: Recorder,
        cancel: Arc<AtomicBool>,
        payloads: Vec<String>,
    }
    impl ProcessingSink for CancelAfterBatch {
        fn on_frame(&mut self, frame: &ifc_lite_processing::FrameEvent) {
            self.recorder.on_frame(frame);
        }
        fn on_batch(&mut self, meshes: &[MeshData], processed: usize, total: usize) {
            self.recorder.on_batch(meshes, processed, total);
            self.payloads
                .extend(meshes.iter().map(|mesh| format!("{mesh:?}")));
            self.cancel.store(true, Ordering::Relaxed);
        }
    }

    let content = load("../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    let full = process(&content, &ProcessingRequest::full_pass(), &mut ());
    assert!(full.meshes.len() > 1, "fixture must require a second chunk");
    for retain in [true, false] {
        let cancel = Arc::new(AtomicBool::new(false));
        let request = ProcessingRequest::default()
            .batching(Batching::new(1, 1))
            .retain_meshes(retain)
            .cancel(cancel.clone());
        let mut sink = CancelAfterBatch {
            recorder: Recorder::default(),
            cancel,
            payloads: Vec::new(),
        };
        let partial = process(&content, &request, &mut sink);
        assert_ordering_contract(&sink.recorder.events, "sink cancellation");
        let batches: Vec<_> = sink
            .recorder
            .events
            .iter()
            .filter_map(|event| match event {
                Event::Batch {
                    processed, total, ..
                } => Some((*processed, *total)),
                _ => None,
            })
            .collect();
        assert_eq!(batches.len(), 1, "no later chunk may be published");
        assert_eq!(batches[0].0, 1);
        assert!(batches[0].1 > batches[0].0);
        assert_eq!(sink.payloads, vec![format!("{:?}", full.meshes[0])]);
        assert_eq!(partial.stats.total_meshes, 1);
        assert_eq!(partial.stats.total_vertices, full.meshes[0].vertex_count());
        assert_eq!(
            partial.stats.total_triangles,
            full.meshes[0].triangle_count()
        );
        assert_eq!(partial.frame, full.frame);
        if retain {
            assert_eq!(
                partial
                    .meshes
                    .iter()
                    .map(|m| format!("{m:?}"))
                    .collect::<Vec<_>>(),
                sink.payloads
            );
        } else {
            assert!(partial.meshes.is_empty());
        }
    }
}
