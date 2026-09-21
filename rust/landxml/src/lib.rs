/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Bounded, event-driven LandXML 1.2 source ingestion.
//!
//! This crate intentionally stops at durable LandXML semantic records. It
//! neither fabricates IFC nor creates renderer meshes; later adapters own
//! coordinate systems, mesh partitioning, and presentation.

mod capture;
pub mod alignment;
mod limits;
mod model;
mod parser;
mod plan;
mod pipe_parser;
mod pipes;
mod preflight;
mod profile;
mod profile_circular;
mod profile_evaluator;
mod semantics;
mod terrain;
mod terrain_validation;
mod xml;

pub use limits::{LandXmlCancellation, LandXmlCancellationFlag, LandXmlLimits};
pub use model::{
    LandXmlCanonicalVertex, LandXmlCapabilities, LandXmlCoordinateSystem, LandXmlDiagnosticCode,
    LandXmlError, LandXmlExtension, LandXmlPoint, LandXmlPolyline, LandXmlProperties,
    LandXmlRenderState, LandXmlSourceId, LandXmlSourcePoint, LandXmlSurface, LandXmlSurfaceKind,
    LandXmlTerrainDiagnostic, LandXmlTerrainDiagnosticCode, LandXmlTinDocument,
    LandXmlTopologyOrigin, LandXmlUnits, LandXmlVersionCapability,
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
pub use plan::{
    parse_landxml_document, parse_landxml_plan, parse_landxml_plan_with_cancel, LandXmlCgPoint,
    LandXmlDocument, LandXmlGeometryKind, LandXmlMonument, LandXmlParcel, LandXmlParcelProbe,
    LandXmlParcelState, LandXmlPlanDocument, LandXmlPlanFeature, LandXmlPlanGeometry,
    LandXmlPlanLimits, LandXmlPlanPoint, LandXmlPlanPointLocation, LandXmlPlanResolver,
    LandXmlPlanSourceBatch,
};
pub use pipe_parser::{parse_landxml_pipe_networks, parse_landxml_pipe_networks_with_cancel};
pub use pipes::{
    LandXmlPipe, LandXmlPipeConnectivity, LandXmlPipeFeature, LandXmlPipeFlow, LandXmlPipeGeometry,
    LandXmlPipeInvert, LandXmlPipeMeasure, LandXmlPipeNetwork, LandXmlPipeNetworkCollection,
    LandXmlPipeNetworkDocument, LandXmlPipePart, LandXmlPipePosition, LandXmlPipeProperties,
    LandXmlPipeRefusal, LandXmlPipeSourceBatch, LandXmlPipeStructure, LandXmlPipeUnits,
    LandXmlStructurePart,
};
