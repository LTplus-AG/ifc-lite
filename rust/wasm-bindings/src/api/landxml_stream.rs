/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Resumable LandXML terrain stream binding.

use super::IfcAPI;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct LandXmlTinStreamSession {
    stream: Option<ifc_lite_landxml::LandXmlTinStreamSession>,
}

fn limits(max_bytes: u32) -> Result<ifc_lite_landxml::LandXmlLimits, ()> {
    if max_bytes == 0 {
        return Err(());
    }
    Ok(ifc_lite_landxml::LandXmlLimits {
        max_bytes: max_bytes as usize,
        ..Default::default()
    })
}

fn json<T: Serialize>(value: T, context: &str) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| {
            JsValue::from_str(&format!("LandXML {context} serialization failed: {error}"))
        })
}

#[wasm_bindgen]
impl LandXmlTinStreamSession {
    #[wasm_bindgen(js_name = advanceChunk)]
    pub fn advance_chunk(&mut self, data: &[u8]) -> Result<(), JsValue> {
        self.stream
            .as_mut()
            .ok_or_else(|| JsValue::from_str("LandXML stream session is closed"))?
            .advance(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Drain only after the renderer has credited this many transport bytes.
    pub fn drain(&mut self, max_bytes: u32) -> Result<JsValue, JsValue> {
        let events = self
            .stream
            .as_mut()
            .ok_or_else(|| JsValue::from_str("LandXML stream session is closed"))?
            .drain(max_bytes as usize)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        // Every event was admitted by the core's 512 KiB credited queue. Do
        // not reassemble metadata here: End must remain a bounded counter
        // record, not a second complete plan document.
        json(events, "stream event")
    }

    pub fn header(&self) -> Result<JsValue, JsValue> {
        json(
            self.stream
                .as_ref()
                .ok_or_else(|| JsValue::from_str("LandXML stream session is closed"))?
                .header(),
            "stream header",
        )
    }

    pub fn finish(&mut self) -> Result<JsValue, JsValue> {
        let summary = self
            .stream
            .as_mut()
            .ok_or_else(|| JsValue::from_str("LandXML stream session is closed"))?
            .finish()
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        self.stream.take();
        json(summary, "stream summary")
    }

    /// Start the resumable metadata cursor. Consumers must continue draining
    /// until [`Self::output_pending`] is false, then abort/free the session.
    #[wasm_bindgen(js_name = finishCursor)]
    pub fn finish_cursor(&mut self) -> Result<(), JsValue> {
        self.stream
            .as_mut()
            .ok_or_else(|| JsValue::from_str("LandXML stream session is closed"))?
            .finish_cursor()
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Whether the host must grant more credited output drain capacity.
    #[wasm_bindgen(js_name = outputPending)]
    pub fn output_pending(&self) -> bool {
        self.stream
            .as_ref()
            .is_some_and(ifc_lite_landxml::LandXmlTinStreamSession::output_pending)
    }

    /// Exact serialized transport bytes currently retained by the Rust queue.
    #[wasm_bindgen(js_name = queuedBytes)]
    pub fn queued_bytes(&self) -> u32 {
        self.stream
            .as_ref()
            .map_or(0, ifc_lite_landxml::LandXmlTinStreamSession::queued_bytes)
            .try_into()
            .unwrap_or(u32::MAX)
    }

    /// Complete credited transport records currently retained by the Rust queue.
    #[wasm_bindgen(js_name = queuedEvents)]
    pub fn queued_events(&self) -> u32 {
        self.stream
            .as_ref()
            .map_or(0, ifc_lite_landxml::LandXmlTinStreamSession::queued_events)
            .try_into()
            .unwrap_or(u32::MAX)
    }

    pub fn abort(&mut self) {
        if let Some(mut stream) = self.stream.take() {
            stream.abort();
        }
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Starts one owned raw-byte LandXML session. The caller must free or abort
    /// the session on every cancellation path.
    #[wasm_bindgen(js_name = createLandXmlTinStreamSession)]
    pub fn create_landxml_tin_stream_session(
        &self,
        max_bytes: u32,
    ) -> Result<LandXmlTinStreamSession, JsValue> {
        Ok(LandXmlTinStreamSession {
            stream: Some(
                ifc_lite_landxml::LandXmlTinStreamSession::new(limits(max_bytes).map_err(
                    |()| JsValue::from_str("LandXML input quota must be greater than zero"),
                )?)
                .map_err(|error| JsValue::from_str(&error.to_string()))?,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::limits;

    const XML: &[u8] = br#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints><Parcels><Parcel name="lot"><CoordGeom><Line><Start pntRef="control"/><End>0 1 0</End></Line></CoordGeom></Parcel></Parcels></LandXML>"#;

    #[test]
    fn issue_5050_stream_binding_refuses_a_zero_quota() {
        assert!(limits(0).is_err());
        assert_eq!(limits(17).expect("positive quota").max_bytes, 17);
    }

    #[test]
    fn issue_5050_cursor_core_emits_derived_plan_records_before_bounded_end() {
        let mut stream = ifc_lite_landxml::LandXmlTinStreamSession::new(
            ifc_lite_landxml::LandXmlLimits::default(),
        )
        .expect("stream");
        stream.advance(XML).expect("input");
        while stream.output_pending() {
            stream
                .drain(ifc_lite_landxml::MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("source header credit");
        }
        stream.finish_cursor().expect("metadata cursor");
        let mut saw_derived = false;
        let mut end_bytes = 0;
        while stream.output_pending() {
            for event in stream
                .drain(ifc_lite_landxml::MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("metadata credit")
            {
                if let ifc_lite_landxml::LandXmlStreamEvent::Metadata(event) = event {
                    match event {
                        ifc_lite_landxml::LandXmlMetadataStreamEvent::Record(
                            ifc_lite_landxml::LandXmlMetadataRecord::PlanResolvedGeometry(_)
                            | ifc_lite_landxml::LandXmlMetadataRecord::PlanResolvedMonument(_)
                            | ifc_lite_landxml::LandXmlMetadataRecord::PlanParcelProbe(_)
                            | ifc_lite_landxml::LandXmlMetadataRecord::PlanSourceBatch(_),
                        ) => saw_derived = true,
                        ifc_lite_landxml::LandXmlMetadataStreamEvent::End(_) => {
                            end_bytes = serde_json::to_vec(&event).expect("end JSON").len();
                        }
                        _ => {}
                    }
                }
            }
        }
        assert!(
            saw_derived,
            "derived plan output must receive normal cursor credit"
        );
        assert!(
            end_bytes < 1024,
            "End must be counters, never a full plan adapter"
        );
    }
}
