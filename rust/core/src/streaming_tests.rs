// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `streaming.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code
//! (see `georef.rs` / `georef_tests.rs`), which also keeps `streaming.rs`
//! inside the module-size ratchet's 400-line limit.

use super::*;
use futures_util::StreamExt;

#[tokio::test]
async fn test_parse_stream_basic() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,$,$);
#3=IFCDOOR('guid3',$,$,$,$,$,$,$);
"#;

    let config = StreamConfig::default();
    let mut stream = parse_stream(content, config);

    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event);
    }

    // Should have: Started, EntityScanned x3, Completed
    assert!(events.len() >= 5);

    // First event should be Started
    match events[0] {
        ParseEvent::Started { .. } => {}
        _ => panic!("Expected Started event"),
    }

    // Last event should be Completed
    match events.last().unwrap() {
        ParseEvent::Completed { entity_count, .. } => {
            assert_eq!(*entity_count, 3);
        }
        _ => panic!("Expected Completed event"),
    }
}

#[tokio::test]
async fn test_parse_stream_skip_types() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCOWNERHISTORY('guid2',$,$,$,$,$,$,$);
#3=IFCWALL('guid3',$,$,$,$,$,$,$);
"#;

    let config = StreamConfig {
        skip_types: vec![IfcType::IfcOwnerHistory],
        ..Default::default()
    };

    let mut stream = parse_stream(content, config);

    let mut entity_count = 0;
    while let Some(event) = stream.next().await {
        if let ParseEvent::EntityScanned { .. } = event {
            entity_count += 1;
        }
    }

    // Should only get 2 entities (skip IfcOwnerHistory)
    assert_eq!(entity_count, 2);
}

#[tokio::test]
async fn test_parse_stream_only_types() {
    let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,$,$);
#3=IFCDOOR('guid3',$,$,$,$,$,$,$);
"#;

    let config = StreamConfig {
        skip_types: vec![],
        only_types: Some(vec![IfcType::IfcWall]),
        ..Default::default()
    };

    let mut stream = parse_stream(content, config);

    let mut entity_count = 0;
    while let Some(event) = stream.next().await {
        if let ParseEvent::EntityScanned { .. } = event {
            entity_count += 1;
        }
    }

    // Should only get 1 entity (only IFCWALL)
    assert_eq!(entity_count, 1);
}

#[tokio::test]
async fn test_parse_stream_skips_garbage_and_completes() {
    // Malformed lines interleaved with valid entities must not truncate the
    // scan or hang: the scanner skips the garbage and still reaches the
    // valid entities and a Completed event.
    let content = r#"
#1=IFCPROJECT('g',$,$,$,$,$,$,$,$);
this is not an entity line at all !!! ;;;
#2=IFCWALL('g2',$,$,$,$,$,$,$);
@%^&*() not valid step
#3=IFCDOOR('g3',$,$,$,$,$,$,$);
"#;

    let mut stream = parse_stream(content, StreamConfig::default());

    let mut entity_count = 0;
    let mut completed = None;
    while let Some(event) = stream.next().await {
        match event {
            ParseEvent::EntityScanned { .. } => entity_count += 1,
            ParseEvent::Completed { entity_count: n, .. } => completed = Some(n),
            _ => {}
        }
    }

    assert_eq!(entity_count, 3, "scanner should skip garbage and find all 3");
    assert_eq!(completed, Some(3), "stream must reach Completed, not truncate");
}

/// The `progress_interval`-th entity used to be swallowed: the poll that
/// scanned it returned a `Progress` event INSTEAD of its `EntityScanned`,
/// while `Completed.entity_count` still counted it. On a 250-record file
/// under the default interval of 100 the stream carried 248 entities, ids
/// 100 and 200 missing, and reported 250. The Progress event now follows the
/// entity on the next poll. Reverting the production change fails the
/// `ids == 1..=250` assertion below (and the count assertion after it).
/// Found by the core review behind #4577 (finding 5).
#[tokio::test]
async fn every_entity_is_emitted_across_a_progress_boundary() {
    let content: String = (1..=250)
        .map(|n| format!("#{n}=IFCWALL('g{n}',$,$,$,$,$,$,$);\n"))
        .collect();

    let mut stream = parse_stream(content.as_str(), StreamConfig::default());
    let mut ids = Vec::new();
    let mut progress_after = Vec::new();
    let mut completed = None;
    while let Some(event) = stream.next().await {
        match event {
            ParseEvent::EntityScanned { id, .. } => ids.push(id),
            ParseEvent::Progress {
                entities_processed, ..
            } => progress_after.push((ids.last().copied(), entities_processed)),
            ParseEvent::Completed { entity_count, .. } => completed = Some(entity_count),
            _ => {}
        }
    }

    assert_eq!(ids, (1..=250).collect::<Vec<u32>>());
    assert_eq!(completed, Some(ids.len()));
    // Progress is a second event for the entity that crossed the interval,
    // so it is emitted right after that entity, and never in its place.
    assert_eq!(progress_after, vec![(Some(100), 100), (Some(200), 200)]);
}

/// The last entity of the file can be the one that owes a Progress event.
/// The queued event must still go out, before `Completed`, rather than die
/// with the state.
#[tokio::test]
async fn a_progress_event_owed_by_the_last_entity_precedes_completed() {
    let content: String = (1..=4)
        .map(|n| format!("#{n}=IFCWALL('g{n}',$,$,$,$,$,$,$);\n"))
        .collect();
    let config = StreamConfig {
        progress_interval: 4,
        ..Default::default()
    };

    let mut stream = parse_stream(content.as_str(), config);
    let mut kinds = Vec::new();
    while let Some(event) = stream.next().await {
        kinds.push(match event {
            ParseEvent::Started { .. } => "started",
            ParseEvent::EntityScanned { .. } => "entity",
            ParseEvent::Progress { .. } => "progress",
            ParseEvent::Completed { .. } => "completed",
            _ => "other",
        });
    }
    assert_eq!(
        kinds,
        ["started", "entity", "entity", "entity", "entity", "progress", "completed"]
    );
}
