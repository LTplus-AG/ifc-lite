// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Streaming IFC Parser
//!
//! Progressive parsing with event callbacks for real-time processing.

use crate::generated::IfcType;
use crate::parser::{report_scan_diagnostics, EntityScanner};
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
    /// Whether [`Self::report_scan_once`] has already fired. The scan is
    /// reported at whichever comes first: the end of the walk, or the state
    /// being dropped under a consumer that stopped early.
    scan_reported: bool,
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
            scan_reported: false,
        }
    }

    /// Report what the scan refused or stopped on, at most once.
    ///
    /// `None` from `next_entity` does not only mean "the file ended": the
    /// scanner skips a record whose instance name does not fit `u32` (#3395)
    /// and stops the whole scan at a record with no terminator (#3695).
    /// Either way this stream is short of what the file declares, so say so
    /// — the same one-line call every other whole-file walk in this
    /// workspace makes (`columnar_index.rs`, `decoder.rs`,
    /// `processor/mod.rs`).
    ///
    /// Called from both the `Completed` branch and [`Drop`], because a
    /// consumer is free to stop polling early (`take`, `break`, a dropped
    /// future) and a refusal the scanner ALREADY recorded would otherwise
    /// die with the stream — silence for exactly the reader who saw the
    /// fewest entities. The flag makes the second call a no-op, so the two
    /// paths cannot double-report (#3791).
    fn report_scan_once(&mut self) {
        if self.scan_reported {
            return;
        }
        self.scan_reported = true;
        report_scan_diagnostics(
            self.scanner.skipped_oversized_ids(),
            self.scanner.malformed_record_start().is_some(),
        );
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

        // Scan for the next entity, skipping filtered types iteratively. A
        // `return self.next_event()` per skipped entity recursed once per skip
        // and could overflow the stack on a long run of skip-listed records.
        loop {
            let Some((id, type_name, start, _end)) = self.scanner.next_entity() else {
                // No more entities - emit Completed event and end stream.
                // `Completed` reads like a clean finish even when the scan
                // came back short, so report before ending. See
                // `report_scan_once` for what "short" covers and why the
                // `Drop` path shares this call (#3791).
                self.report_scan_once();
                self.completed = true;
                let duration_ms = get_timestamp() - self.start_time;
                return Some(ParseEvent::Completed {
                    duration_ms,
                    entity_count: self.entities_scanned,
                    triangle_count: self.triangles_generated,
                });
            };

            // Parse entity type
            let ifc_type = IfcType::from_str(type_name);

            // Check if we should skip this type
            if self.config.skip_types.contains(&ifc_type) {
                continue; // Skip to next
            }

            // Check if we should only process specific types
            if let Some(ref only_types) = self.config.only_types {
                if !only_types.contains(&ifc_type) {
                    continue; // Skip to next
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

            return Some(event);
        }
    }
}

/// Report the scan even when the consumer never asked for `Completed`.
///
/// `parse_stream` hands back a lazy stream, so "stop reading" is a normal,
/// supported thing for a caller to do (`take`, a `break`, a cancelled task) —
/// and it is the caller who then sees the FEWEST entities. Reporting only on
/// the `Completed` branch would stay silent for exactly that reader while
/// reporting to the one who read everything (#3791).
impl Drop for ParserState<'_> {
    fn drop(&mut self) {
        self.report_scan_once();
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
#[path = "streaming_tests.rs"]
mod streaming_tests;
