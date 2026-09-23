/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Resumable LandXML terrain stream binding.

use super::landxml::{endpoints::LandXmlParseOptionsJs, LandXmlParseOptions};
use super::IfcAPI;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct LandXmlTinStreamSession {
    stream: Option<ifc_lite_landxml::LandXmlTinStreamSession>,
}

/// #5175 step A.3: the streaming session used to build its limits solely
/// from `max_bytes`, so a caller-supplied `assumedLinearUnit` override (and
/// every other option `parseLandXmlSourceBytesWithOptions` accepts) was
/// unreachable from the viewer's actual LandXML load path, which creates its
/// session through `createLandXmlTinStreamSession`, never through the
/// non-streaming entry point. `options` now reuses the exact same
/// `LandXmlParseOptions` shape (deserialized by the caller in
/// `IfcAPI::create_landxml_tin_stream_session`) instead of a second,
/// narrower options type.
///
/// `max_bytes` stays the dedicated, always-validated positional quota this
/// binding has always taken; it wins over an `options.maxBytes` field if one
/// is also supplied, so this merge cannot silently ignore either the
/// existing required argument or a newly-supplied option.
///
/// Returns [`LimitsError`], not `JsValue`, on purpose: constructing an actual
/// `wasm_bindgen::JsValue` (e.g. via `JsValue::from_str`) aborts the process
/// outside a real wasm32 host, so this function -- and its native
/// `#[cfg(test)]` coverage below -- must stay `JsValue`-free on every path a
/// native test can reach. Only the `#[wasm_bindgen]`-exported caller, which
/// native tests never invoke, converts to `JsValue`.
fn limits(
    max_bytes: u32,
    options: LandXmlParseOptions,
) -> Result<ifc_lite_landxml::LandXmlLimits, LimitsError> {
    if max_bytes == 0 {
        return Err(LimitsError::ZeroQuota);
    }
    let (mut xml, _alignment) = options.limits().map_err(LimitsError::Options)?;
    xml.max_bytes = max_bytes as usize;
    Ok(xml)
}

#[derive(Debug)]
enum LimitsError {
    ZeroQuota,
    Options(JsValue),
}

impl From<LimitsError> for JsValue {
    fn from(error: LimitsError) -> JsValue {
        match error {
            LimitsError::ZeroQuota => {
                JsValue::from_str("LandXML input quota must be greater than zero")
            }
            LimitsError::Options(value) => value,
        }
    }
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
    ///
    /// `options` is the same shape `parseLandXmlSourceBytesWithOptions`
    /// accepts (see `LandXmlParseOptionsJs`) and is optional so every
    /// existing single-argument call site keeps working unchanged. A bad
    /// `assumedLinearUnit` token (or any other invalid option) refuses here,
    /// at session construction, never partway through a stream (#5175).
    #[wasm_bindgen(js_name = createLandXmlTinStreamSession)]
    pub fn create_landxml_tin_stream_session(
        &self,
        max_bytes: u32,
        options: Option<LandXmlParseOptionsJs>,
    ) -> Result<LandXmlTinStreamSession, JsValue> {
        let options: LandXmlParseOptions = match options {
            Some(value) => serde_wasm_bindgen::from_value(JsValue::from(value)).map_err(
                |error| JsValue::from_str(&format!("LXML004: invalid parser options: {error}")),
            )?,
            None => LandXmlParseOptions::default(),
        };
        Ok(LandXmlTinStreamSession {
            stream: Some(
                ifc_lite_landxml::LandXmlTinStreamSession::new(limits(max_bytes, options)?)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?,
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{limits, LandXmlParseOptions};

    const XML: &[u8] = br#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><CgPoints><CgPoint name="control">0 0 0</CgPoint></CgPoints><Parcels><Parcel name="lot"><CoordGeom><Line><Start pntRef="control"/><End>0 1 0</End></Line></CoordGeom></Parcel></Parcels></LandXML>"#;

    /// A real producer's unitless renderable TIN (same shape as the
    /// non-streaming A.2 fixture in `units_required_5175.rs`): no
    /// `<Units>` element at all, three points, one authored face.
    const UNITLESS_RENDERABLE_TIN: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Surfaces>
    <Surface name="Example_Terrain">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">123.456 789.123 145.678</P>
          <P id="2">145.789 801.456 146.234</P>
          <P id="3">167.234 823.789 147.123</P>
        </Pnts>
        <Faces>
          <F>1 2 3</F>
        </Faces>
      </Definition>
    </Surface>
  </Surfaces>
</LandXML>"#;

    #[test]
    fn issue_5050_stream_binding_refuses_a_zero_quota() {
        assert!(limits(0, LandXmlParseOptions::default()).is_err());
        assert_eq!(
            limits(17, LandXmlParseOptions::default())
                .expect("positive quota")
                .max_bytes,
            17
        );
    }

    /// #5175 step A.3: `assumedLinearUnit` must reach the streaming session
    /// through `limits()`, the exact function `createLandXmlTinStreamSession`
    /// calls, not just the non-streaming `parseLandXmlSourceBytesWithOptions`
    /// entry point. Without the option the merged limits still carry no
    /// override (so LXML009 refusal is untouched); with it, the resolved
    /// `LandXmlLimits.assumed_linear_unit` is exactly the supplied token, and
    /// the required positional `max_bytes` still wins over any
    /// `options.maxBytes`.
    #[test]
    fn issue_5175_limits_merges_assumed_linear_unit_and_keeps_positional_max_bytes() {
        let without_override = limits(64, LandXmlParseOptions::default())
            .expect("default options merge with a positive quota");
        assert!(without_override.assumed_linear_unit.is_none());
        assert_eq!(without_override.max_bytes, 64);

        // Deserialized like the real JS boundary would, rather than a struct
        // literal, so this also pins the camelCase field name callers use.
        let options: LandXmlParseOptions =
            serde_json::from_str(r#"{"assumedLinearUnit":"foot","maxBytes":999999}"#)
                .expect("valid options JSON");
        let with_override =
            limits(64, options).expect("an assumed-unit override merges with a positive quota");
        assert_eq!(with_override.assumed_linear_unit.as_deref(), Some("foot"));
        assert_eq!(
            with_override.max_bytes, 64,
            "the positional max_bytes argument must win over options.maxBytes"
        );
    }

    /// #5175 step A.3: exercises the exact limits the streaming session
    /// binding hands to `ifc_lite_landxml::LandXmlTinStreamSession::new`.
    /// This is the path the browser actually takes to load LandXML (see
    /// `apps/viewer/src/hooks/ingest/landXmlBlobCursor.ts`), unlike the
    /// non-streaming `parse_landxml_tin_with_cancel` coverage in
    /// `rust/landxml/tests/units_required_5175.rs`. Without an override the
    /// unitless renderable TIN still refuses with LXML009; with it, the
    /// session streams the surface through to completion.
    #[test]
    fn issue_5175_streaming_session_honours_the_assumed_unit_override() {
        let refused_limits = limits(
            UNITLESS_RENDERABLE_TIN.len() as u32,
            LandXmlParseOptions::default(),
        )
        .expect("positive quota");
        let mut refused_session =
            ifc_lite_landxml::LandXmlTinStreamSession::new(refused_limits).expect("session");
        let advance_result = refused_session.advance(UNITLESS_RENDERABLE_TIN);
        while refused_session.output_pending() {
            refused_session
                .drain(ifc_lite_landxml::MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("drain queued output");
        }
        let refusal = match advance_result {
            Err(error) => error,
            Ok(()) => refused_session
                .finish_cursor()
                .expect_err("no override configured must still refuse LXML009 (#5175)"),
        };
        assert_eq!(refusal.code.as_str(), "LXML009");

        let options: LandXmlParseOptions = serde_json::from_str(r#"{"assumedLinearUnit":"meter"}"#)
            .expect("valid options JSON");
        let unlocked_limits = limits(UNITLESS_RENDERABLE_TIN.len() as u32, options)
            .expect("positive quota with an override");
        let mut unlocked_session =
            ifc_lite_landxml::LandXmlTinStreamSession::new(unlocked_limits).expect("session");
        unlocked_session
            .advance(UNITLESS_RENDERABLE_TIN)
            .expect("an assumed-unit override unlocks the unitless renderable TIN (#5175)");
        let mut drained = Vec::new();
        while unlocked_session.output_pending() {
            drained.extend(
                unlocked_session
                    .drain(ifc_lite_landxml::MAX_LANDXML_STREAM_DRAIN_BYTES)
                    .expect("drain queued output"),
            );
        }
        unlocked_session
            .finish_cursor()
            .expect("an assumed-unit override lets the stream session finish (#5175)");
        while unlocked_session.output_pending() {
            drained.extend(
                unlocked_session
                    .drain(ifc_lite_landxml::MAX_LANDXML_STREAM_DRAIN_BYTES)
                    .expect("drain queued metadata"),
            );
        }
        assert!(
            drained
                .iter()
                .any(|event| matches!(event, ifc_lite_landxml::LandXmlStreamEvent::Surface(_))),
            "the renderable surface must actually stream once the override unlocks it (#5175)"
        );
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
                    match event.as_ref() {
                        ifc_lite_landxml::LandXmlMetadataStreamEvent::Record(record)
                            if matches!(
                                record.as_ref(),
                                ifc_lite_landxml::LandXmlMetadataRecord::PlanResolvedGeometry(_)
                                    | ifc_lite_landxml::LandXmlMetadataRecord::PlanResolvedMonument(
                                        _
                                    )
                                    | ifc_lite_landxml::LandXmlMetadataRecord::PlanParcelProbe(_)
                                    | ifc_lite_landxml::LandXmlMetadataRecord::PlanSourceBatch(_),
                            ) =>
                        {
                            saw_derived = true
                        }
                        ifc_lite_landxml::LandXmlMetadataStreamEvent::End(_) => {
                            end_bytes = serde_json::to_vec(event.as_ref()).expect("end JSON").len();
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
