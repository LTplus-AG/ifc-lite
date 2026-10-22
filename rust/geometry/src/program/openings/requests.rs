// SPDX-License-Identifier: MPL-2.0
//! One reached source admission, source-free numerical packet, or canonical
//! item child. Source requests are tags: the entities they read stay in the
//! owning controller, so a request can neither copy nor replay source.
use super::decision::Decisions;
use super::planar::PlanarHost;
use super::ready::ProbePlacement;
use crate::program::opening::OpeningBounds;
use crate::router::processing::SourceHygiene;
use crate::router::transforms::WorldFrame;
use crate::router::voids::probe::ExtrudedSolidInfo;
use crate::router::voids::{OpeningType, RectParam};
use crate::router::OpeningDiagnostic;
use crate::{Mesh, Result, Vector3};
use ifc_lite_core::DecodedEntity;
use nalgebra::{Matrix3, Matrix4, Point2};
use std::collections::VecDeque;

/// A source admission, executed against the requesting controller's own state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpeningSource {
    /// Decode the next requested opening occurrence.
    Decode,
    /// The occurrence's merged body through the product pipeline.
    Body,
    /// A probe's meshed representation items and unit-scaled placement.
    Probe,
    /// The element-frame RTC offset of the reached raw-coordinate item.
    RawChoice,
    /// The reached item's authored extrusion direction.
    Direction,
    /// The host's exact parametric box.
    RectHost,
    /// The reached opening's parametric boxes.
    RectBoxes,
    /// The host's single extruded solid.
    SolidHost,
    /// The reached opening's extruded solids.
    Solids,
    /// The router's unit scale and RTC offset.
    Frame,
}

/// Owned numerical work. Every payload is values only: no decoder, router or
/// source entity enters, so a packet can run after its source scope ended.
pub(crate) enum OpeningReady {
    Metrics(Vec<Mesh>),
    BoundsDecision(OpeningBounds),
    Decision(Decisions),
    Fallback {
        mesh: Mesh,
        bounds: OpeningBounds,
    },
    ProbeDirection {
        value: Option<(Vector3<f64>, Option<Matrix4<f64>>)>,
        placement: Matrix4<f64>,
    },
    ProbeParts {
        parts: Vec<Mesh>,
        placement: ProbePlacement,
    },
    FinishClassifier {
        output: Vec<OpeningType>,
        diagnostic: Vec<OpeningDiagnostic>,
    },
    /// Merge classified rectangles into larger boxes.
    Merge(Vec<OpeningType>),
    /// Every opening box must share the host frame (a signed permutation).
    RectOrientation {
        host: Matrix3<f64>,
        boxes: Vec<RectParam>,
    },
    /// The boxes must account for the meshed opening by volume.
    RectReconcile {
        boxes: Vec<RectParam>,
        meshes: Vec<Mesh>,
    },
    PlanarHost(ExtrudedSolidInfo),
    /// One opening solid's footprint; the host moves through the packet.
    Footprint {
        host: PlanarHost,
        solid: ExtrudedSolidInfo,
    },
    PlanarTransform {
        placement: Matrix4<f64>,
        scale: f64,
        rtc: (f64, f64, f64),
    },
}

pub(crate) enum OpeningReply {
    /// A request its controller could not serve (a protocol fault).
    Refused(crate::Error),
    Decoded(Result<DecodedEntity>),
    /// A body source or an item child's frame parts.
    Parts(Result<Vec<Mesh>>),
    Probe(Result<(Vec<DecodedEntity>, Matrix4<f64>)>, SourceHygiene, WorldFrame),
    RawChoice(Result<Option<(f64, f64, f64)>>),
    Direction(Result<Option<(Vector3<f64>, Option<Matrix4<f64>>)>>),
    Metrics(VecDeque<Mesh>, usize, usize),
    BoundsDecision(OpeningBounds, bool),
    Decision(Decisions, Option<OpeningType>),
    Fallback(OpeningType),
    ProbeDirection(Option<Vector3<f64>>),
    ProbeParts(ProbePlacement),
    ClassifierFinished(Vec<OpeningType>, Vec<OpeningDiagnostic>),
    Merged(Vec<OpeningType>, Vec<OpeningType>),
    RectHost(Option<RectParam>),
    RectBoxes(Option<Vec<RectParam>>),
    RectOrientation(Option<Vec<RectParam>>),
    RectReconciled(Option<Vec<RectParam>>),
    SolidHost(Option<ExtrudedSolidInfo>),
    PlanarHost(Option<PlanarHost>),
    Solids(Option<Vec<ExtrudedSolidInfo>>),
    Footprint(PlanarHost, Option<Vec<Point2<f64>>>),
    Frame(f64, (f64, f64, f64)),
    PlanarTransform(Matrix4<f64>),
}
