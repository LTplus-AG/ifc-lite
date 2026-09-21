/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Credit-resumable metadata event production.

use super::super::{
    LandXmlMetadataRecordFragment, LandXmlMetadataStreamEnd, LandXmlMetadataStreamEvent,
    LandXmlMetadataStreamHeader, LandXmlStreamHeader, MAX_LANDXML_STREAM_EVENT_BYTES,
    MAX_LANDXML_STREAM_METADATA_RECORD_BYTES,
};
use super::{AlignmentStreamParts, PipeStreamParts, PlanStreamParts, TerrainStreamParts};
use crate::stream::derived::{AlignmentDerivedCursor, PlanDerivedCursor};

pub(crate) struct MetadataCursor {
    header: Option<LandXmlMetadataStreamHeader>,
    terrain: TerrainStreamParts,
    plan: Option<PlanStreamParts>,
    plan_derived: Option<PlanDerivedCursor>,
    alignment: Option<AlignmentStreamParts>,
    alignment_derived: Option<AlignmentDerivedCursor>,
    pipe: PipeStreamParts,
    pending_record: Option<PendingRecordFragments>,
    end: Option<LandXmlMetadataStreamEnd>,
}

/// JSON is produced once for a legal large value, then moved out in bounded
/// pieces. It is never placed in the credited output queue as one oversized event.
struct PendingRecordFragments {
    record: String,
    payload: Vec<u8>,
    offset: usize,
    sequence: usize,
}

const MAX_METADATA_FRAGMENT_PAYLOAD_BYTES: usize = 32 * 1024;

impl MetadataCursor {
    pub(crate) fn new(
        header: LandXmlStreamHeader,
        mut terrain: TerrainStreamParts,
        plan: crate::LandXmlPlanDocument,
        alignment: crate::alignment::LandXmlAlignmentDocument,
        mut pipe: PipeStreamParts,
        end: LandXmlMetadataStreamEnd,
    ) -> Self {
        Self {
            header: Some(LandXmlMetadataStreamHeader {
                stream: header,
                terrain: terrain.take_header(),
                plan: PlanStreamParts::header(&plan),
                alignments: AlignmentStreamParts::header(&alignment),
                pipe_networks: pipe.take_header(),
            }),
            terrain,
            plan: None,
            plan_derived: Some(PlanDerivedCursor::new(plan)),
            alignment: None,
            alignment_derived: Some(AlignmentDerivedCursor::new(alignment)),
            pipe,
            pending_record: None,
            end: Some(end),
        }
    }

    pub(crate) fn next_event(
        &mut self,
    ) -> Result<Option<LandXmlMetadataStreamEvent>, crate::LandXmlError> {
        if let Some(pending) = &mut self.pending_record {
            let end =
                (pending.offset + MAX_METADATA_FRAGMENT_PAYLOAD_BYTES).min(pending.payload.len());
            let event = LandXmlMetadataStreamEvent::RecordFragment(LandXmlMetadataRecordFragment {
                record: pending.record.clone(),
                sequence: pending.sequence,
                continued: end < pending.payload.len(),
                payload_utf8: pending.payload[pending.offset..end].to_vec(),
            });
            pending.offset = end;
            pending.sequence += 1;
            if pending.offset == pending.payload.len() {
                self.pending_record = None;
            }
            return Ok(Some(event));
        }
        let event = self.next_unfragmented_event()?;
        let Some(event) = event else { return Ok(None) };
        let LandXmlMetadataStreamEvent::Record(record) = event else {
            return Ok(Some(event));
        };
        let value = record.serialize_value().map_err(|value| {
            crate::xml::error(
                crate::LandXmlDiagnosticCode::InvalidSemantic,
                format!("stream metadata serialization failed: {value}"),
            )
        })?;
        if value.len() + 1024 < MAX_LANDXML_STREAM_EVENT_BYTES {
            return Ok(Some(LandXmlMetadataStreamEvent::Record(record)));
        }
        if value.len() > MAX_LANDXML_STREAM_METADATA_RECORD_BYTES {
            return Err(crate::xml::error(
                crate::LandXmlDiagnosticCode::LimitExceeded,
                "metadata record exceeds bounded fragmentation limit",
            ));
        }
        self.pending_record = Some(PendingRecordFragments {
            record: record.wire_name().to_owned(),
            payload: value,
            offset: 0,
            sequence: 0,
        });
        self.next_event()
    }

    fn next_unfragmented_event(
        &mut self,
    ) -> Result<Option<LandXmlMetadataStreamEvent>, crate::LandXmlError> {
        if let Some(header) = self.header.take() {
            return Ok(Some(LandXmlMetadataStreamEvent::Header(header)));
        }
        if let Some(record) = self.terrain.next_record() {
            return Ok(Some(LandXmlMetadataStreamEvent::Record(record)));
        }
        loop {
            if let Some(cursor) = self.plan_derived.as_mut() {
                if let Some(record) = cursor.next_record()? {
                    return Ok(Some(LandXmlMetadataStreamEvent::Record(record)));
                }
                let plan = cursor
                    .take_plan()
                    .expect("completed plan cursor owns its document");
                self.plan_derived = None;
                self.plan = Some(PlanStreamParts::without_header(plan));
                continue;
            }
            if let Some(parts) = self.plan.as_mut() {
                if let Some(record) = parts.next_record() {
                    return Ok(Some(LandXmlMetadataStreamEvent::Record(record)));
                }
                self.plan = None;
                continue;
            }
            if let Some(cursor) = self.alignment_derived.as_mut() {
                if let Some(record) = cursor.next_record() {
                    return Ok(Some(LandXmlMetadataStreamEvent::Record(record)));
                }
                let alignment = cursor
                    .take_document()
                    .expect("completed alignment cursor owns its document");
                self.alignment_derived = None;
                self.alignment = Some(AlignmentStreamParts::without_header(alignment));
                continue;
            }
            if let Some(parts) = self.alignment.as_mut() {
                if let Some(record) = parts.next_record() {
                    return Ok(Some(LandXmlMetadataStreamEvent::Record(record)));
                }
                self.alignment = None;
                continue;
            }
            if let Some(record) = self.pipe.next_record() {
                return Ok(Some(LandXmlMetadataStreamEvent::Record(record)));
            }
            return Ok(self.end.take().map(LandXmlMetadataStreamEvent::End));
        }
    }
}
