// SPDX-License-Identifier: MPL-2.0
//! explicit admission of canonical processing output into a retained document.
//!
//! This adapter never parses IFC or selects a kernel. It retains the entire
//! processing result and copies only execution buffers into object-local mesh
//! definitions. Its memory cost is opt-in; ordinary loads do not construct it.

use crate::ProcessingResult;
use ifc_lite_geometry::document::{
    DefinitionHandle, DocumentError, GeometryDocument, OccurrenceHandle,
};
use ifc_lite_geometry::Mesh;
use std::collections::BTreeMap;

/// An admitted display mesh, linked to its untouched processing record.
///
/// Definitions use local coordinates. Occurrence transforms place them into
/// [`ProcessingResult::frame`], not directly into IFC absolute world space.
#[derive(Debug, Clone, Copy)]
pub struct RetainedMeshRecord {
    pub mesh_index: usize,
    pub definition: DefinitionHandle,
    pub occurrence: OccurrenceHandle,
}

/// One existing instance applied to one template mesh. A multi-mesh template
/// contributes multiple records, sharing its existing mesh definitions.
#[derive(Debug, Clone, Copy)]
pub struct RetainedInstanceRecord {
    pub instance_index: usize,
    pub mesh_index: usize,
    pub occurrence: OccurrenceHandle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedGeometryLocation {
    Mesh(usize),
    Instance(usize),
}

#[derive(Debug, PartialEq, Eq)]
pub enum RetainedGeometryErrorCause {
    Document(DocumentError),
    MissingTemplate { template_express_id: u32 },
}

impl std::fmt::Display for RetainedGeometryErrorCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Document(error) => std::fmt::Display::fmt(error, f),
            Self::MissingTemplate {
                template_express_id,
            } => write!(f, "instance template {template_express_id} has no mesh"),
        }
    }
}

impl std::error::Error for RetainedGeometryErrorCause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Document(error) => Some(error),
            Self::MissingTemplate { .. } => None,
        }
    }
}

/// Failed admission identifies the processing record; no partial document escapes.
pub struct RetainedGeometryError {
    pub location: RetainedGeometryLocation,
    pub source: RetainedGeometryErrorCause,
    processed: Box<ProcessingResult>,
}

impl RetainedGeometryError {
    /// Recover the canonical result when execution admission is refused.
    pub fn into_processing_result(self) -> ProcessingResult {
        *self.processed
    }
}

impl std::fmt::Debug for RetainedGeometryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RetainedGeometryError")
            .field("location", &self.location)
            .field("source", &self.source)
            .finish()
    }
}

impl std::fmt::Display for RetainedGeometryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?} failed retained admission: {}",
            self.location, self.source
        )
    }
}

impl std::error::Error for RetainedGeometryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// Retained execution geometry plus the complete canonical processing result.
///
/// Texture, appearance, source attribution, instance records and [`crate::MeshFrame`]
/// remain authoritative in `processed()`. Imported meshes are approximations;
/// admission makes no claim that their source geometry is mathematically exact.
/// Exact arithmetic is an explicit subsequent operation contract.
pub struct RetainedGeometry {
    processed: ProcessingResult,
    document: GeometryDocument,
    records: Vec<RetainedMeshRecord>,
    instances: Vec<RetainedInstanceRecord>,
}

impl RetainedGeometry {
    /// Admit an already-produced result. Runs no second load or geometry pipeline.
    ///
    /// Copies positions, normals and indices for execution. The original result
    /// remains recoverable without reconstructed or dropped presentation fields.
    /// If processing was cancelled or filtered, this retains that same partial or
    /// filtered result: admission must not be interpreted as load completion.
    pub fn try_from_processing(processed: ProcessingResult) -> Result<Self, RetainedGeometryError> {
        match admit(&processed) {
            Ok((document, records, instances)) => Ok(Self {
                processed,
                document,
                records,
                instances,
            }),
            Err((location, source)) => Err(RetainedGeometryError {
                location,
                source,
                processed: Box::new(processed),
            }),
        }
    }

    /// Canonical geometry, presentation, placement, instances and diagnostics.
    pub fn processed(&self) -> &ProcessingResult {
        &self.processed
    }

    /// Immutable document view; operation results cannot silently replace a display mesh.
    pub fn document(&self) -> &GeometryDocument {
        &self.document
    }

    pub fn records(&self) -> &[RetainedMeshRecord] {
        &self.records
    }

    /// Additional placed occurrences for every canonical instance/template mesh
    /// pair. Appearance and source metadata remain in `processed().instances`.
    pub fn instances(&self) -> &[RetainedInstanceRecord] {
        &self.instances
    }

    /// Return every original record and metadata field without a lossy conversion.
    pub fn into_processing_result(self) -> ProcessingResult {
        self.processed
    }
}

type Admission = (
    GeometryDocument,
    Vec<RetainedMeshRecord>,
    Vec<RetainedInstanceRecord>,
);
type AdmissionError = (RetainedGeometryLocation, RetainedGeometryErrorCause);

fn admit(processed: &ProcessingResult) -> Result<Admission, AdmissionError> {
    let mut document = GeometryDocument::new();
    let mut records = Vec::with_capacity(processed.meshes.len());
    let mut templates: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (mesh_index, source) in processed.meshes.iter().enumerate() {
        let mut mesh = Mesh::new();
        mesh.positions = source.positions.clone();
        mesh.normals = source.normals.clone();
        mesh.indices = source.indices.clone();
        let definition = document
            .add_mesh_definition(source.geometry_item_id.unwrap_or(source.express_id), mesh)
            .map_err(|source| {
                (
                    RetainedGeometryLocation::Mesh(mesh_index),
                    RetainedGeometryErrorCause::Document(source),
                )
            })?;
        let [x, y, z] = source.origin;
        let occurrence = document
            .add_occurrence(
                definition,
                source.express_id,
                [
                    1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z, 0.0, 0.0, 0.0, 1.0,
                ],
            )
            .map_err(|source| {
                (
                    RetainedGeometryLocation::Mesh(mesh_index),
                    RetainedGeometryErrorCause::Document(source),
                )
            })?;
        records.push(RetainedMeshRecord {
            mesh_index,
            definition,
            occurrence,
        });
        templates
            .entry(source.express_id)
            .or_default()
            .push(mesh_index);
    }
    let instances = admit_instances(processed, &records, &templates, &mut document)?;
    Ok((document, records, instances))
}

fn admit_instances(
    processed: &ProcessingResult,
    records: &[RetainedMeshRecord],
    templates: &BTreeMap<u32, Vec<usize>>,
    document: &mut GeometryDocument,
) -> Result<Vec<RetainedInstanceRecord>, AdmissionError> {
    let mut instances = Vec::with_capacity(processed.instances.len());
    for (instance_index, source) in processed.instances.iter().enumerate() {
        let location = RetainedGeometryLocation::Instance(instance_index);
        let mesh_indices = templates.get(&source.template_express_id).ok_or((
            location,
            RetainedGeometryErrorCause::MissingTemplate {
                template_express_id: source.template_express_id,
            },
        ))?;
        for &mesh_index in mesh_indices {
            let mut transform = source.transform.map(f64::from);
            let origin = processed.meshes[mesh_index].origin;
            // Row-major A * T(origin): instance transforms address the baked
            // template frame (origin + local positions). Preserve that frame
            // in f64 rather than dropping its origin or narrowing it again.
            for row in 0..4 {
                transform[row * 4 + 3] += transform[row * 4] * origin[0]
                    + transform[row * 4 + 1] * origin[1]
                    + transform[row * 4 + 2] * origin[2];
            }
            let occurrence = document
                .add_occurrence(records[mesh_index].definition, source.express_id, transform)
                .map_err(|error| (location, RetainedGeometryErrorCause::Document(error)))?;
            instances.push(RetainedInstanceRecord {
                instance_index,
                mesh_index,
                occurrence,
            });
        }
    }
    Ok(instances)
}
