// SPDX-License-Identifier: MPL-2.0
//! One reached source admission, source-free numerical work, or canonical child.
use super::control::OpeningOutput;
use super::decision::Decisions;
use super::planar::PlanarHost;
use crate::program::opening::OpeningBounds;
use crate::program::traversal::RepresentationItemsRequest;
use crate::program::{EntryPolicy, GeometryProgram, ProductProgram};
use crate::router::transforms::WorldFrame;
use crate::router::voids::{probe::ExtrudedSolidInfo, OpeningType, RectParam};
use crate::{GeometryRouter, Mesh, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::{Matrix4, Point2};
use std::{collections::VecDeque, sync::Arc};

pub(crate) enum OpeningChild {
    Body(DecodedEntity),
    Item {
        item: DecodedEntity,
        offset: Option<(f64, f64, f64)>,
    },
}
impl OpeningChild {
    /// Returns the actual child and whether its output is one mesh or parts.
    pub(crate) fn admit(self, router: &GeometryRouter) -> Result<(GeometryProgram, bool)> {
        crate::resource::check_current()?;
        match self {
            Self::Body(element) => Ok((GeometryProgram::opening_body(element), false)),
            Self::Item {
                item,
                offset: Some(offset),
            } => Ok((GeometryProgram::representation_item(item, offset), true)),
            Self::Item { item, offset: None } => {
                if item.ifc_type == ifc_lite_core::IfcType::IfcMappedItem {
                    Ok((GeometryProgram::mapped_merged(&item, router)?, false))
                } else {
                    Ok((
                        GeometryProgram::representation_item(item, router.rtc_offset()),
                        true,
                    ))
                }
            }
        }
    }
}
pub(crate) enum OpeningSource {
    Gate(OpeningGate),
    Decode(u32),
    Representations {
        element: DecodedEntity,
        meshes: bool,
    },
    Placement(DecodedEntity),
    Items(RepresentationItemsRequest),
    Direction(DecodedEntity),
    RawChoice {
        element: DecodedEntity,
        item: DecodedEntity,
    },
    RectHost(DecodedEntity),
    RectBoxes(DecodedEntity),
    SolidHost(DecodedEntity),
    Solids(DecodedEntity),
    Frame,
}
pub(crate) enum OpeningGate {
    Parametric,
    Planar,
}
pub(crate) enum OpeningReply {
    Numerical(u16, Box<OpeningReply>),
    Error(crate::Error),
    Captured(Box<OpeningReply>, crate::construction::ConstructionReports),
    Decoded(Result<DecodedEntity>),
    Representations(Result<Option<ProductProgram>>),
    Placement(Result<(Matrix4<f64>, f64, WorldFrame)>),
    Items(Result<crate::program::ItemProgram>),
    Direction(Result<Option<(Vector3<f64>, Option<Matrix4<f64>>)>>),
    RawChoice(Result<Option<(f64, f64, f64)>>),
    RectHost(Result<Option<RectParam>>),
    RectBoxes(Result<Option<Vec<RectParam>>>),
    SolidHost(Result<Option<ExtrudedSolidInfo>>),
    Solids(Result<Option<Vec<ExtrudedSolidInfo>>>),
    Frame(f64, (f64, f64, f64)),
    Parts(Result<Vec<Mesh>>),
    Metrics(VecDeque<Mesh>, usize, usize),
    BoundsDecision(OpeningBounds, bool),
    Decision(Decisions, Option<OpeningType>),
    Fallback(OpeningType),
    Merged(Vec<OpeningType>, Vec<OpeningType>),
    Gate(bool),
    ProbePlacement(Matrix4<f64>, WorldFrame),
    ProbeDirection(Option<Vector3<f64>>),
    ProbeParts(Vec<Mesh>, OpeningBounds),
    RectOrientation(Option<Vec<RectParam>>),
    RectReconciled(Option<Vec<RectParam>>),
    PlanarHost(Option<Arc<PlanarHost>>),
    Footprint(Option<Vec<Point2<f64>>>),
    PlanarTransform(Matrix4<f64>),
    ClassifierFinished(Vec<OpeningType>, Vec<crate::router::OpeningDiagnostic>),
    Finished(OpeningOutput),
}
impl OpeningSource {
    pub(crate) fn execute(
        self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
    ) -> OpeningReply {
        let (reply, reports) = crate::processors::diagnostic_capture::capture(|| {
            if let Err(stop) = crate::resource::check_current() {
                return OpeningReply::Error(stop.into());
            }
            self.admit(router, decoder)
        });
        OpeningReply::Captured(Box::new(reply), reports)
    }
    fn admit(self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> OpeningReply {
        match self {
            Self::Gate(OpeningGate::Parametric) => {
                OpeningReply::Gate(crate::rect_fast::param_enabled())
            }
            Self::Gate(OpeningGate::Planar) => {
                OpeningReply::Gate(crate::router::voids::bool2d_path::enabled())
            }
            Self::Decode(id) => OpeningReply::Decoded((|| {
                crate::resource::check_current()?;
                let value = decoder.decode_by_id(id);
                crate::resource::check_current()?;
                value.map_err(Into::into)
            })()),
            Self::Representations { element, meshes } => OpeningReply::Representations((|| {
                crate::resource::check_current()?;
                let value = ProductProgram::opening(
                    &element,
                    if meshes {
                        EntryPolicy::OpeningItemMeshes
                    } else {
                        EntryPolicy::OpeningItemBounds
                    },
                    decoder,
                );
                crate::resource::check_current()?;
                value
            })(
            )),
            Self::Placement(element) => OpeningReply::Placement((|| {
                let placement = crate::resource::observe(
                    router.get_placement_transform_from_element(&element, decoder),
                );
                let placement = match placement {
                    Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                    result => result.unwrap_or_else(|_| Matrix4::identity()),
                };
                Ok((
                    placement,
                    router.unit_scale(),
                    WorldFrame {
                        rtc_offset: router.rtc_offset(),
                        local_frame_enabled: false,
                    },
                ))
            })()),
            Self::Items(request) => OpeningReply::Items(request.admit(decoder)),
            Self::Direction(item) => OpeningReply::Direction(
                router.extract_extrusion_direction_recursive_checked(&item, decoder),
            ),
            Self::RawChoice { element, item } => OpeningReply::RawChoice((|| {
                crate::resource::check_current()?;
                if !router.has_rtc_offset()
                    || !router
                        .representation_item_first_vertex_meters(&item, decoder)
                        .is_some_and(crate::coord_is_large)
                {
                    crate::resource::check_current()?;
                    return Ok(None);
                }
                if router.processor_for(&item.ifc_type).is_none() {
                    return Ok(None);
                }
                crate::resource::observe(router.element_frame_rtc(&element, decoder))
            })()),
            Self::RectHost(element) => {
                OpeningReply::RectHost(router.parametric_rect_probe_checked(&element, decoder))
            }
            Self::RectBoxes(element) => {
                OpeningReply::RectBoxes(router.parametric_rect_probe_all_checked(&element, decoder))
            }
            Self::SolidHost(element) => {
                OpeningReply::SolidHost(router.host_extruded_solid_checked(&element, decoder))
            }
            Self::Solids(element) => {
                OpeningReply::Solids(router.opening_extruded_solids_checked(&element, decoder))
            }
            Self::Frame => OpeningReply::Frame(router.unit_scale(), router.rtc_offset()),
        }
    }
}
/// Every payload contains numerical values only. Source entity snapshots remain
/// in the owning controller while these packets execute.
pub(crate) enum OpeningReady {
    Metrics(Vec<Mesh>),
    BoundsDecision(OpeningBounds),
    Decision(Decisions),
    Fallback {
        mesh: Mesh,
        bounds: OpeningBounds,
    },
    Merge(Vec<OpeningType>),
    ProbePlacement {
        placement: Matrix4<f64>,
        scale: f64,
        frame: WorldFrame,
    },
    ProbeDirection {
        value: Option<(Vector3<f64>, Option<Matrix4<f64>>)>,
        placement: Matrix4<f64>,
    },
    ProbeParts {
        parts: Vec<Mesh>,
        hygiene: crate::router::processing::SourceHygiene,
        placement: Matrix4<f64>,
        frame: WorldFrame,
        meshes: bool,
        direction: Option<Vector3<f64>>,
    },
    RectOrientation {
        host: nalgebra::Matrix3<f64>,
        boxes: Vec<RectParam>,
    },
    RectReconcile {
        boxes: Vec<RectParam>,
        meshes: Vec<Mesh>,
    },
    PlanarHost(ExtrudedSolidInfo),
    Footprint {
        host: Arc<PlanarHost>,
        solid: ExtrudedSolidInfo,
    },
    PlanarTransform {
        host: Arc<PlanarHost>,
        scale: f64,
        rtc: (f64, f64, f64),
    },
    FinishClassifier {
        output: Vec<OpeningType>,
        diagnostic: Vec<crate::router::OpeningDiagnostic>,
    },
    Finish(OpeningOutput),
}

impl OpeningReply {
    pub(in crate::program) fn numerical_tag(&self) -> Option<u16> {
        match self {
            Self::Numerical(tag, _) => Some(*tag),
            Self::Captured(reply, _) => reply.numerical_tag(),
            _ => None,
        }
    }
}
impl OpeningReady {
    pub(in crate::program) fn tag(&self) -> u16 {
        match self {
            Self::Metrics(_) => 1,
            Self::BoundsDecision(_) => 2,
            Self::Decision(_) => 3,
            Self::Fallback { .. } => 4,
            Self::Merge(_) => 5,
            Self::ProbePlacement { .. } => 7,
            Self::ProbeDirection { .. } => 8,
            Self::ProbeParts { .. } => 9,
            Self::RectOrientation { .. } => 10,
            Self::RectReconcile { .. } => 11,
            Self::PlanarHost(_) => 12,
            Self::Footprint { .. } => 13,
            Self::PlanarTransform { .. } => 14,
            Self::FinishClassifier { .. } => 15,
            Self::Finish(_) => 16,
        }
    }
}
