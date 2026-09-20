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
mod preflight;
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
