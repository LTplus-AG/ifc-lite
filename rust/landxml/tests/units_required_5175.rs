/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! #5175: "a renderable numeric TIN surface requires declared `<Units>`" must
//! hold identically across every parse entry point. Before this fix the rule
//! lived only in the streaming session (`stream/output.rs`): a unitless
//! renderable TIN refused there, but `parse_landxml_tin` and
//! `parse_landxml_document` rendered the exact same bytes with `units: None`.
//! `require_units_for_renderable_tin` in `parser/finalize.rs` is now the one
//! implementation both `Parser::finish` (shared by the non-streaming path and
//! `LandXmlTinStreamSession::finish_cursor`) and the streaming session's
//! per-surface drain call.

use ifc_lite_landxml::{
    parse_landxml_document, parse_landxml_tin, parse_landxml_tin_with_cancel,
    LandXmlDiagnosticCode, LandXmlError, LandXmlLimits, LandXmlRenderState, LandXmlStreamEvent,
    LandXmlTinStreamSession, LandXmlTopologyOrigin, MAX_LANDXML_STREAM_DRAIN_BYTES,
};

/// `bonsai-topo/data/output/example.xml`: a real producer's LandXML 1.2 TIN
/// export. It declares a `<CoordinateSystem>` but never declares `<Units>`,
/// and its `Example_Terrain` surface has 3 points and an authored face, so it
/// is a numeric, renderable TIN by every existing rule in this crate.
const UNITLESS_RENDERABLE_TIN: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <CoordinateSystem epsgCode="3857" name="Web Mercator"/>
  <Project name="Example Survey Project">
    <Application name="Open BIM Survey Workflow" version="1.0"/>
  </Project>
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

fn assert_lxml009(error: &LandXmlError) {
    assert_eq!(
        error.code,
        LandXmlDiagnosticCode::InvalidSemantic,
        "unexpected diagnostic code: {error:?}"
    );
    assert_eq!(error.code.as_str(), "LXML009");
    assert!(
        !error.message.ends_with('.'),
        "crate message style has no trailing period: {:?}",
        error.message
    );
    assert!(
        error.message.contains("LandXML/Units"),
        "message must name the missing element: {:?}",
        error.message
    );
    assert!(
        error.message.contains("linearUnit"),
        "message must name the required attribute: {:?}",
        error.message
    );
}

#[test]
fn unitless_renderable_tin_refuses_on_every_path_5175() {
    let bytes = UNITLESS_RENDERABLE_TIN.as_bytes();

    // Entry point 1: the non-streaming TIN parser. This is the path #5175
    // found silently rendering a unitless surface (units: None, render_state:
    // Rendered, capabilities.renderable_tin: true) instead of refusing.
    let tin_error = parse_landxml_tin(bytes)
        .expect_err("a unitless renderable TIN must refuse via parse_landxml_tin (#5175)");
    assert_lxml009(&tin_error);

    // Entry point 2: the combined TIN+plan document parser, which reaches
    // the same terrain surfaces through `crate::parser::parse_landxml_document`.
    let document_error = parse_landxml_document(bytes)
        .expect_err("a unitless renderable TIN must refuse via parse_landxml_document (#5175)");
    assert_lxml009(&document_error);

    // Entry point 3: the streaming session. This already refused before the
    // fix; keep it pinned so a future change to the shared rule cannot
    // silently stop enforcing it here while still enforcing it elsewhere.
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    let mut drained = Vec::new();
    let advance_result = session.advance(bytes);
    while session.output_pending() {
        drained.extend(
            session
                .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("drain queued output"),
        );
    }
    let stream_error = match advance_result {
        Err(error) => error,
        Ok(()) => session
            .finish_cursor()
            .expect_err("a unitless renderable TIN must refuse over the stream session (#5175)"),
    };
    assert_lxml009(&stream_error);

    // The streaming header/surface contract in `stream/output.rs` refuses a
    // Rendered surface before it is enqueued, so no renderable surface
    // fragment for this document may ever reach the host.
    assert!(
        !drained
            .iter()
            .any(|event| matches!(event, LandXmlStreamEvent::Surface(_))),
        "a unitless renderable surface must never leave the stream session (#5175)"
    );
}

/// The units requirement binds only a numeric, *renderable* TIN. A faceless
/// (preserved-only) surface with no declared units must stay inspectable on
/// every path, exactly as `LandXmlTinDocument::units`'s doc comment promises.
/// This pins the boundary the fix must not cross.
#[test]
fn unitless_preserved_only_surface_still_parses_everywhere_5175() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Surfaces>
    <Surface name="survey-only">
      <Definition surfType="VOLUME"/>
    </Surface>
  </Surfaces>
</LandXML>"#;
    let bytes = xml.as_bytes();

    let tin = parse_landxml_tin(bytes).expect("preserved-only unitless surfaces stay inspectable");
    assert!(tin.units.is_none());
    assert_eq!(tin.surfaces.len(), 1);
    assert_eq!(tin.surfaces[0].render_state, LandXmlRenderState::PreservedOnly);
    assert_eq!(tin.surfaces[0].topology_origin, LandXmlTopologyOrigin::PreservedOnly);
    assert!(!tin.capabilities.renderable_tin);

    let document = parse_landxml_document(bytes)
        .expect("preserved-only unitless surfaces stay inspectable via parse_landxml_document");
    assert!(document.terrain.units.is_none());
    assert_eq!(
        document.terrain.surfaces[0].render_state,
        LandXmlRenderState::PreservedOnly
    );

    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default()).expect("session");
    session.advance(bytes).expect("preserved-only advance");
    let mut drained = Vec::new();
    while session.output_pending() {
        drained.extend(
            session
                .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("drain queued output"),
        );
    }
    session
        .finish_cursor()
        .expect("preserved-only unitless surfaces stay inspectable over the stream session");
    while session.output_pending() {
        drained.extend(
            session
                .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
                .expect("drain queued metadata"),
        );
    }
    assert!(
        drained
            .iter()
            .any(|event| matches!(event, LandXmlStreamEvent::Header(_))),
        "a unit-less preserved-only document still emits its transport header"
    );
}

/// #5175 step A.2: a real producer's unitless renderable TIN (the same
/// `bonsai-topo` shape as [`UNITLESS_RENDERABLE_TIN`]) becomes parseable when
/// the caller supplies an explicit, audited `assumed_linear_unit` override.
/// The resulting units record must carry the correct scale for the assumed
/// token and must be flagged `assumed: true` so nothing downstream can
/// mistake it for a declared `<Units>` element.
#[test]
fn assumed_unit_override_unlocks_a_unitless_renderable_tin_5175() {
    let limits = LandXmlLimits {
        assumed_linear_unit: Some("foot".to_owned()),
        ..LandXmlLimits::default()
    };
    let document =
        parse_landxml_tin_with_cancel(UNITLESS_RENDERABLE_TIN.as_bytes(), &limits, None)
            .expect("an assumed-unit override must unlock a unitless renderable TIN (#5175)");

    assert!(document.capabilities.renderable_tin);
    assert_eq!(document.surfaces.len(), 1);
    assert_eq!(document.surfaces[0].render_state, LandXmlRenderState::Rendered);

    let units = document
        .units
        .expect("effective units (declared or assumed) must be present");
    assert!(
        units.assumed,
        "units synthesized from an override must be flagged assumed: true (#5175)"
    );
    assert_eq!(units.linear_unit, "foot");
    assert_eq!(units.elevation_unit, "foot");
    // The same scale the declared-<Units> path uses for "foot" (0.3048 m).
    assert!((units.linear_scale_to_meters - 0.3048).abs() < f64::EPSILON);
    assert_eq!(units.elevation_scale_to_meters, units.linear_scale_to_meters);

    // Points are stored in their raw, source-declared magnitude; scaling is a
    // downstream concern. Prove a consumer applying the assumed scale gets
    // the correct meters for the first authored point (easting "789.123").
    let point = document.surfaces[0]
        .points
        .iter()
        .find(|point| point.id == "1")
        .expect("point id=1 from UNITLESS_RENDERABLE_TIN");
    assert_eq!(point.easting, 789.123);
    let easting_meters = point.easting * units.linear_scale_to_meters;
    assert!((easting_meters - 789.123 * 0.3048).abs() < 1e-9);
}

/// Guards A.1 against regressing under the A.2 change: with no override
/// configured (the default), a unitless renderable TIN must still refuse
/// with LXML009, using the same `parse_landxml_tin_with_cancel` entry point
/// the override travels through.
#[test]
fn assumed_unit_override_absent_still_refuses_lxml009_5175() {
    let limits = LandXmlLimits::default();
    assert!(limits.assumed_linear_unit.is_none());
    let error = parse_landxml_tin_with_cancel(UNITLESS_RENDERABLE_TIN.as_bytes(), &limits, None)
        .expect_err("no override configured must still refuse a unitless renderable TIN (#5175)");
    assert_lxml009(&error);
}

/// A declared `<Units>` element always wins over a caller-supplied override:
/// the parsed document must reflect the *declared* unit, not the assumed
/// one, and the units record must not be flagged `assumed`. The override is
/// not silently dropped, though: a warning records that it was ignored,
/// since the caller's assumption and the file's declaration might disagree.
#[test]
fn declared_units_win_over_an_assumed_override_5175() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units>
    <Metric linearUnit="meter" elevationUnit="meter"/>
  </Units>
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
    let limits = LandXmlLimits {
        assumed_linear_unit: Some("foot".to_owned()),
        ..LandXmlLimits::default()
    };
    let document = parse_landxml_tin_with_cancel(xml.as_bytes(), &limits, None)
        .expect("a declared surface with an ignored override still parses (#5175)");

    let units = document.units.expect("declared units must be present");
    assert_eq!(units.linear_unit, "meter");
    assert!(
        !units.assumed,
        "declared units must never be flagged assumed, even when an override was supplied (#5175)"
    );
    assert!(
        document
            .warnings
            .iter()
            .any(|warning| warning.contains("override was ignored")),
        "an override ignored in favour of a declaration must be recorded, not silently dropped: {:?}",
        document.warnings
    );
}

/// An unknown override token is refused with the identical "unsupported
/// LandXML unit" diagnostic a bad declared `<Units>` element would get. It
/// must never silently fall back to meters, and the refusal must fire even
/// when the document turns out not to need units at all (a preserved-only
/// surface never triggers LXML009), because a bad *option* is always an
/// error regardless of whether the file would have needed it.
#[test]
fn unknown_override_token_is_refused_not_defaulted_to_meters_5175() {
    let bad_limits = LandXmlLimits {
        assumed_linear_unit: Some("furlong".to_owned()),
        ..LandXmlLimits::default()
    };

    let error = parse_landxml_tin_with_cancel(UNITLESS_RENDERABLE_TIN.as_bytes(), &bad_limits, None)
        .expect_err("an unknown assumed-unit token must refuse, not fall back to meters (#5175)");
    assert_eq!(error.code, LandXmlDiagnosticCode::InvalidSemantic);
    assert!(
        error.message.contains("unsupported LandXML unit"),
        "must reuse the declared-<Units> unsupported-unit diagnostic verbatim: {:?}",
        error.message
    );

    let preserved_only_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Surfaces>
    <Surface name="survey-only">
      <Definition surfType="VOLUME"/>
    </Surface>
  </Surfaces>
</LandXML>"#;
    let preserved_only_error =
        parse_landxml_tin_with_cancel(preserved_only_xml.as_bytes(), &bad_limits, None)
            .expect_err(
                "an unknown override token must refuse even for content that never needed units \
                 (#5175)",
            );
    assert_eq!(
        preserved_only_error.code,
        LandXmlDiagnosticCode::InvalidSemantic
    );
    assert!(preserved_only_error.message.contains("unsupported LandXML unit"));
}

/// An override widens what units are willing to unlock; it must never widen
/// what topology counts as renderable. A faceless TIN with no boundary and
/// no breaklines refuses terrain synthesis for reasons unrelated to units
/// (`missing_outer_boundary`) and stays `PreservedOnly` whether or not an
/// override is configured.
#[test]
fn override_does_not_resurrect_a_surface_preserved_for_non_units_reasons_5175() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Surfaces>
    <Surface name="faceless">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">0 0 0</P>
          <P id="2">0 10 0</P>
          <P id="3">10 10 0</P>
        </Pnts>
      </Definition>
    </Surface>
  </Surfaces>
</LandXML>"#;
    let limits = LandXmlLimits {
        assumed_linear_unit: Some("meter".to_owned()),
        ..LandXmlLimits::default()
    };
    let document = parse_landxml_tin_with_cancel(xml.as_bytes(), &limits, None)
        .expect("a preserved-only faceless TIN parses regardless of an override (#5175)");

    assert!(!document.capabilities.renderable_tin);
    assert_eq!(document.surfaces.len(), 1);
    let surface = &document.surfaces[0];
    assert_eq!(surface.render_state, LandXmlRenderState::PreservedOnly);
    assert_eq!(surface.topology_origin, LandXmlTopologyOrigin::PreservedOnly);
    assert!(
        surface.terrain_diagnostic.is_some(),
        "the surface must still carry its real, non-units refusal reason"
    );
}

/// #5175 regression, found by the viewer suite: the units gate must key on
/// whether a surface actually DRAWS, not on `render_state`.
///
/// A TIN whose faces are all hidden (`<F i="true">`) is still `Rendered` — it
/// has points and faces — but it puts no geometry on screen. #5042 established
/// that such a document is preserved and inspectable without units
/// ("preserves an empty or fully hidden TIN without requiring render units"),
/// and gating on `render_state` alone broke that contract on both paths.
#[test]
fn unitless_fully_hidden_tin_needs_no_units_5175() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Surfaces>
    <Surface name="all-hidden">
      <Definition surfType="TIN">
        <Pnts>
          <P id="1">0 0 1</P>
          <P id="2">0 10 1</P>
          <P id="3">10 0 1</P>
        </Pnts>
        <Faces>
          <F i="true">1 2 3</F>
        </Faces>
      </Definition>
    </Surface>
  </Surfaces>
</LandXML>"#;
    let bytes = xml.as_bytes();

    let tin = parse_landxml_tin(bytes)
        .expect("a fully hidden TIN draws nothing, so it needs no declared unit");
    assert!(tin.units.is_none());
    assert_eq!(tin.surfaces.len(), 1);
    assert_eq!(tin.surfaces[0].hidden_face_count, 1);
    assert_eq!(tin.surfaces[0].faces.len(), 1);

    parse_landxml_document(bytes)
        .expect("the same holds through parse_landxml_document");

    // And through the streaming session the viewer actually loads with.
    let mut session = LandXmlTinStreamSession::new(LandXmlLimits::default())
        .expect("session construction");
    session
        .advance(bytes)
        .expect("a fully hidden TIN streams without units");
    while session.output_pending() {
        session
            .drain(MAX_LANDXML_STREAM_DRAIN_BYTES)
            .expect("drain queued output");
    }
    session
        .finish_cursor()
        .expect("a fully hidden TIN finalizes without a units refusal (#5175)");
}
