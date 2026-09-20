/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded, event-driven LandXML 1.2 source ingestion.
//!
//! This crate intentionally stops at durable LandXML semantic records. It
//! neither fabricates IFC nor creates renderer meshes; later adapters own
//! coordinate systems, mesh partitioning, and presentation.

mod capture;
mod limits;
mod model;
mod parser;
mod pipe_parser;
mod pipes;
mod preflight;
mod profile;
mod profile_circular;
mod profile_evaluator;
mod semantics;
mod xml;

pub use limits::{LandXmlCancellation, LandXmlCancellationFlag, LandXmlLimits};
pub use model::{
    LandXmlCapabilities, LandXmlDiagnosticCode, LandXmlError, LandXmlExtension, LandXmlPoint,
    LandXmlPolyline, LandXmlProperties, LandXmlRenderState, LandXmlSourceId, LandXmlSourcePoint,
    LandXmlSurface, LandXmlSurfaceKind, LandXmlTinDocument, LandXmlUnits, LandXmlVersionCapability,
};
pub use parser::{
    classify_landxml_version, parse_landxml_tin, parse_landxml_tin_with_cancel,
    LANDXML_10_NAMESPACE, LANDXML_11_NAMESPACE, LANDXML_12_NAMESPACE,
};
pub use profile::{
    LandXmlAlignment, LandXmlCapabilityDiagnostic, LandXmlCapabilityDiagnosticCode,
    LandXmlCrossSection, LandXmlCrossSectionPoint, LandXmlCrossSectionPointDataFormat,
    LandXmlCrossSectionSegment, LandXmlCrossSectionSurface, LandXmlCrossSectionSurfaceKind,
    LandXmlGradeLine, LandXmlPreservedOnlyExtension, LandXmlPreservedOnlyExtensionKind,
    LandXmlProfile, LandXmlProfileEvaluationError, LandXmlProfileKind, LandXmlProfilePoint,
    LandXmlRoadway, LandXmlVerticalCurve, LandXmlVerticalCurveKind,
};
pub use pipe_parser::{parse_landxml_pipe_networks, parse_landxml_pipe_networks_with_cancel};
pub use pipes::{
    LandXmlPipe, LandXmlPipeConnectivity, LandXmlPipeFlow, LandXmlPipeGeometry, LandXmlPipeInvert,
    LandXmlPipeMeasure, LandXmlPipeNetwork, LandXmlPipeNetworkDocument, LandXmlPipePart,
    LandXmlPipePosition, LandXmlPipeProperties, LandXmlPipeRefusal, LandXmlPipeSourceBatch,
    LandXmlPipeStructure, LandXmlPipeUnits, LandXmlStructurePart,
};
