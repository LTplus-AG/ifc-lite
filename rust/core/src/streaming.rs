// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Streaming IFC Parser
//!
//! Progressive parsing with event callbacks for real-time processing.

use crate::generated::IfcType;
use crate::parser::EntityScanner;
use futures_core::Stream;
use futures_util::stream;
use std::pin::Pin;

/// Parse event types emitted during streaming parse
#[derive(Debug, Clone)]
pub enum ParseEvent {
    /// Parsing started
    Started {
        /// Total file size in bytes
        file_size: usize,
        /// Timestamp when parsing started
        timestamp: f64,
    },

    /// Entity discovered during scanning
    EntityScanned {
        /// Entity ID
        id: u32,
        /// Entity type
        ifc_type: IfcType,
        /// Position in file
        position: usize,
    },

    /// Geometry processing completed for an entity
    GeometryReady {
        /// Entity ID
        id: u32,
        /// Vertex count
        vertex_count: usize,
        /// Triangle count
        triangle_count: usize,
    },

    /// Progress update
    Progress {
        /// Current phase (e.g., "Scanning", "Parsing", "Processing geometry")
        phase: String,
        /// Progress percentage (0-100)
        percent: f32,
        /// Entities processed so far
        entities_processed: usize,
        /// Total entities
        total_entities: usize,
    },

    /// Parsing completed
    Completed {
        /// Total duration in milliseconds
        duration_ms: f64,
        /// Total entities parsed
        entity_count: usize,
        /// Total triangles generated
        triangle_count: usize,
    },

    /// Error occurred
    Error {
        /// Error message
        message: String,
        /// Position where error occurred
        position: Option<usize>,
    },
}

/// Streaming parser configuration
#[derive(Debug, Clone)]
pub struct StreamConfig {
    /// Yield progress events every N entities
    pub progress_interval: usize,
    /// Skip these entity types during scanning
    pub skip_types: Vec<IfcType>,
    /// Only process these entity types (if specified)
    pub only_types: Option<Vec<IfcType>>,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            progress_interval: 100,
            skip_types: vec![
                IfcType::IfcOwnerHistory,
                IfcType::IfcPerson,
                IfcType::IfcOrganization,
                IfcType::IfcApplication,
            ],
            only_types: None,
        }
    }
}

/// Stream IFC file parsing with events
pub fn parse_stream<T>(
    content: &T,
    config: StreamConfig,
) -> Pin<Box<dyn Stream<Item = ParseEvent> + '_>>
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    Box::pin(stream::unfold(
        ParserState::new(content, config),
        |mut state| async move { state.next_event().map(|event| (event, state)) },
    ))
}

/// Internal parser state for streaming
struct ParserState<'a> {
    content: &'a [u8],
    scanner: EntityScanner<'a>,
    config: StreamConfig,
    started: bool,
    completed: bool,
    start_time: f64,
    entities_scanned: usize,
    total_entities: usize,
    triangles_generated: usize,
}

impl<'a> ParserState<'a> {
    fn new(content: &'a [u8], config: StreamConfig) -> Self {
        Self {
            content,
            scanner: EntityScanner::new(content),
            config,
            started: false,
            completed: false,
            start_time: 0.0,
            entities_scanned: 0,
            total_entities: 0,
            triangles_generated: 0,
        }
    }

    fn next_event(&mut self) -> Option<ParseEvent> {
        // Stream has ended - CRITICAL: prevents infinite loop!
        if self.completed {
            return None;
        }

        // Emit Started event on first call
        if !self.started {
            self.started = true;
            self.start_time = get_timestamp();
            return Some(ParseEvent::Started {
                file_size: self.content.len(),
                timestamp: self.start_time,
            });
        }

        // Scan for next entity
        if let Some((id, type_name, start, _end)) = self.scanner.next_entity() {
            // Parse entity type
            let ifc_type = IfcType::from_str(type_name);

            // Check if we should skip this type
            if self.config.skip_types.contains(&ifc_type) {
                return self.next_event(); // Skip to next
            }

            // Check if we should only process specific types
            if let Some(ref only_types) = self.config.only_types {
                if !only_types.contains(&ifc_type) {
                    return self.next_event(); // Skip to next
                }
            }

            self.entities_scanned += 1;

            // Emit EntityScanned event
            let event = ParseEvent::EntityScanned {
                id,
                ifc_type,
                position: start,
            };

            // Check if we should emit progress
            if self
                .entities_scanned
                .is_multiple_of(self.config.progress_interval)
            {
                // Note: In a real implementation, we'd estimate total_entities
                // by doing a quick pre-scan or using file size heuristics
                return Some(ParseEvent::Progress {
                    phase: "Scanning entities".to_string(),
                    percent: 0.0, // Would calculate based on position/file_size
                    entities_processed: self.entities_scanned,
                    total_entities: self.total_entities,
                });
            }

            Some(event)
        } else {
            // No more entities - emit Completed event and end stream
            self.completed = true;
            let duration_ms = get_timestamp() - self.start_time;
            Some(ParseEvent::Completed {
                duration_ms,
                entity_count: self.entities_scanned,
                triangle_count: self.triangles_generated,
            })
        }
    }
}

/// Get current timestamp (mock implementation for native Rust)
/// In WASM, this would use web_sys::window().performance().now()
fn get_timestamp() -> f64 {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.0
    }

    #[cfg(target_arch = "wasm32")]
    {
        // In WASM, would use:
        // web_sys::window().unwrap().performance().unwrap().now()
        0.0
    }
}

#[cfg(test)]
mod tests {
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
}
