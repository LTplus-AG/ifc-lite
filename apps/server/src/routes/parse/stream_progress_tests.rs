// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the progress-checkpoint sidecar (issue #3897).

use super::*;

/// The recorder must attach each checkpoint to the batch it accounts for.
/// The live pipeline emits Batch then the Progress that covers it, and also
/// emits Progress with NO batch before it — the leading `processed: 0`, and
/// any chunk that produced no meshes. Only the post-batch values become
/// checkpoints; the others must not shift the batch alignment by one.
#[test]
fn only_progress_events_that_follow_a_batch_become_checkpoints() {
    let mut recorder = StreamProgressRecorder::default();
    recorder.on_progress(0, 40); // leading progress, no batch yet
    recorder.on_batch();
    recorder.on_progress(12, 40);
    recorder.on_progress(19, 40); // a chunk that emitted no meshes
    recorder.on_batch();
    recorder.on_progress(40, 40);

    let progress = recorder.take();
    assert_eq!(progress.total_jobs, 40);
    assert_eq!(progress.after_batch, vec![12, 40]);
}

/// `take` must leave the recorder empty, so a second Complete on the same
/// stream cannot re-cache the first one's checkpoints.
#[test]
fn take_empties_the_recorder() {
    let mut recorder = StreamProgressRecorder::default();
    recorder.on_batch();
    recorder.on_progress(3, 3);
    assert_eq!(recorder.take().after_batch, vec![3]);
    assert!(recorder.take().after_batch.is_empty());
}

/// A sidecar that no longer deserializes must read as absent (the caller then
/// falls back to mesh units), never as an error or a partial value.
#[tokio::test]
async fn a_corrupt_sidecar_reads_as_absent() {
    let dir = std::env::temp_dir().join(format!(
        "ifc-lite-server-test-stream-progress-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let cache = DiskCache::new(dir.to_str().unwrap()).await;

    assert!(load_stream_progress(&cache, "never-written").await.is_none());

    cache
        .set_bytes(&stream_progress_cache_key("corrupt"), b"{not json")
        .await
        .unwrap();
    assert!(load_stream_progress(&cache, "corrupt").await.is_none());

    let progress = StreamProgress {
        total_jobs: 7,
        after_batch: vec![3, 7],
    };
    cache_stream_progress(&cache, "good", &progress).await;
    let read_back = load_stream_progress(&cache, "good").await.unwrap();
    assert_eq!(read_back.total_jobs, 7);
    assert_eq!(read_back.after_batch, vec![3, 7]);
}
