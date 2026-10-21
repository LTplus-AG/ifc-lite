// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Restricted, complete provenance for source-planarity normalization (#7714).

use super::EntityDecoder;
use crate::{parser::EntityScanner, slot, AttributeValue, IfcType};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

/// A single project's explicit SI length unit and uniform 3D context tree.
/// Values are in file units; there is no inferred/default Precision or unit.
#[derive(Clone, Debug)]
pub struct UniformContextPrecision {
    pub project: u32,
    pub root_context: u32,
    pub contexts: Vec<u32>,
    pub length_unit: u32,
    pub metres_per_unit: f64,
    pub precision: f64,
}

/// Private once cells owned by the immutable SourceBundle, never by a supplied
/// index or a separately installed cache. Strict and permissive reads differ.
#[derive(Default)]
pub(crate) struct UniformContextPrecisionCache {
    strict: OnceLock<Option<UniformContextPrecision>>,
    permissive: OnceLock<Option<UniformContextPrecision>>,
}

#[derive(Default)]
pub(super) struct PrecisionCache {
    pub(super) local: Option<(bool, Option<UniformContextPrecision>)>,
    #[cfg(test)]
    scans: usize,
}

impl EntityDecoder<'_> {
    /// Certify the restricted uniform-context domain used by FacetedBrep
    /// normalization. Every declared context and representation is inspected,
    /// including unused contexts. Missing, conflicting, cyclic or unsupported
    /// provenance declines. Unlike `geometric_context_precision_range`, this
    /// verifies inheritance, project ownership and an explicit length unit.
    pub fn uniform_context_precision(&mut self) -> Option<&UniformContextPrecision> {
        if self
            .uniform_precision_cache
            .local
            .as_ref()
            .is_none_or(|(strict, _)| *strict != self.strict_reals)
        {
            let source = self.source_bundle.clone().filter(|source| source.owns_decoder(self));
            let certificate = if let Some(source) = source {
                let shared = &source.uniform_precision;
                let cell = if self.strict_reals {
                    &shared.strict
                } else {
                    &shared.permissive
                };
                cell.get_or_init(|| self.scan_uniform_precision()).clone()
            } else {
                self.scan_uniform_precision()
            };
            self.uniform_precision_cache.local = Some((self.strict_reals, certificate));
        }
        self.uniform_precision_cache.local.as_ref()?.1.as_ref()
    }

    fn scan_uniform_precision(&mut self) -> Option<UniformContextPrecision> {
        #[cfg(test)]
        {
            self.uniform_precision_cache.scans += 1;
        }
        self.certify_uniform_precision()
    }

    fn certify_uniform_precision(&mut self) -> Option<UniformContextPrecision> {
        self.schema_version()?;
        let mut scanner = EntityScanner::new(self.content);
        let mut projects = Vec::new();
        let mut contexts = BTreeMap::new();
        let mut representations = Vec::new();
        let mut seen = BTreeSet::new();
        while let Some((id, name, start, end)) = scanner.next_entity() {
            let name = name.to_ascii_uppercase();
            let relevant = name == "IFCPROJECT"
                || name == "IFCPROJECTLIBRARY"
                || name.contains("REPRESENTATIONCONTEXT")
                || name.contains("REPRESENTATIONSUBCONTEXT")
                || name.ends_with("REPRESENTATION")
                || name == "IFCSHAPEMODEL"
                || name.starts_with("IFCCARTESIANTRANSFORMATIONOPERATOR");
            if !relevant {
                continue;
            }
            if !seen.insert(id) || seen.len() > 100_000 {
                return None;
            }
            self.require_current_record(id, start, end)?;
            let entity = self.decode_at_uncached(start, end).ok()?;
            match entity.ifc_type {
                IfcType::IfcProject => projects.push(entity),
                IfcType::IfcGeometricRepresentationContext
                | IfcType::IfcGeometricRepresentationSubContext => {
                    contexts.insert(id, entity);
                }
                _ if entity.ifc_type.is_subtype_of(IfcType::IfcRepresentation) => {
                    representations.push(entity.ref_at(slot::IfcRepresentation::CONTEXT_OF_ITEMS)?)
                }
                _ if entity
                    .ifc_type
                    .is_subtype_of(IfcType::IfcProductRepresentation) => {}
                _ if name.starts_with("IFCCARTESIANTRANSFORMATIONOPERATOR") => {
                    certified_mapped_scale(&entity, &name)?;
                }
                _ => return None,
            }
        }
        if scanner.skipped_oversized_ids() != 0
            || scanner.malformed_record_start().is_some()
            || projects.len() != 1
            || contexts.is_empty()
            || contexts.len() > 128
        {
            return None;
        }
        let project = projects.pop()?;
        let roots: Vec<_> = contexts
            .iter()
            .filter(|(_, c)| c.ifc_type == IfcType::IfcGeometricRepresentationContext)
            .map(|(&id, _)| id)
            .collect();
        if roots.len() != 1 {
            return None;
        }
        let root_id = roots[0];
        let owned = project
            .attr(slot::IfcProject::REPRESENTATION_CONTEXTS)?
            .as_list()?;
        if owned.len() != 1 || owned[0].as_entity_ref() != Some(root_id) {
            return None;
        }
        self.certified_context_tree(&contexts, root_id)?;
        let precision = contexts.get(&root_id)?
            .real_at(slot::IfcGeometricRepresentationContext::PRECISION)?;
        for representation in representations {
            if !contexts.contains_key(&representation) {
                return None;
            }
        }
        let (length_unit, metres_per_unit) = self.certified_si_length(&project)?;
        Some(UniformContextPrecision {
            project: project.id,
            root_context: root_id,
            contexts: contexts.keys().copied().collect(),
            length_unit,
            metres_per_unit,
            precision,
        })
    }

    fn certified_context_tree(
        &mut self,
        contexts: &BTreeMap<u32, crate::DecodedEntity>,
        root_id: u32,
    ) -> Option<()> {
        let root = contexts.get(&root_id)?;
        if root
            .attr(slot::IfcGeometricRepresentationContext::COORDINATE_SPACE_DIMENSION)?
            .as_int()?
            != 3
        {
            return None;
        }
        let precision = root.real_at(slot::IfcGeometricRepresentationContext::PRECISION)?;
        if !precision.is_finite() || precision <= 0.0 {
            return None;
        }
        let wcs = self
            .decode_by_id(
                root.ref_at(slot::IfcGeometricRepresentationContext::WORLD_COORDINATE_SYSTEM)?,
            )
            .ok()?;
        if wcs.ifc_type != IfcType::IfcAxis2Placement3D || !self.certified_wcs(&wcs)? {
            return None;
        }
        for (&id, context) in contexts {
            if id == root_id {
                continue;
            }
            // EXPRESS derives these fields from ParentContext. Accept only
            // actual derived slots, never a conflicting explicit declaration.
            for index in [
                slot::IfcGeometricRepresentationContext::COORDINATE_SPACE_DIMENSION.index(),
                slot::IfcGeometricRepresentationContext::PRECISION.index(),
                slot::IfcGeometricRepresentationContext::WORLD_COORDINATE_SYSTEM.index(),
                slot::IfcGeometricRepresentationContext::TRUE_NORTH.index(),
            ] {
                if !matches!(context.get(index)?, AttributeValue::Derived) {
                    return None;
                }
            }
            // EXPRESS ParentNoSub forbids a subcontext parent. Requiring the
            // one owned root also declines cycles without a reference walk.
            if context.ref_at(slot::IfcGeometricRepresentationSubContext::PARENT_CONTEXT)?
                != root_id
            {
                return None;
            }
        }
        Some(())
    }

    /// Certification must describe the same records that references resolve.
    /// A later unrelated record can otherwise shadow a scanned context id.
    fn require_current_record(&mut self, id: u32, start: usize, end: usize) -> Option<()> {
        let declared = self.content.get(start..end)?;
        std::ptr::eq(self.get_raw_bytes(id)?, declared).then_some(())
    }

    fn certified_wcs(&mut self, placement: &crate::DecodedEntity) -> Option<bool> {
        let location = self
            .decode_by_id(placement.ref_at(slot::IfcAxis2Placement3D::LOCATION)?)
            .ok()?;
        if location.ifc_type != IfcType::IfcCartesianPoint {
            return Some(false);
        }
        let coordinates = location
            .attr(slot::IfcCartesianPoint::COORDINATES)?
            .as_list()?;
        if coordinates.len() != 3
            || coordinates
                .iter()
                .any(|v| v.as_float().is_none_or(|v| !v.is_finite()))
        {
            return Some(false);
        }
        for axis in [
            slot::IfcAxis2Placement3D::AXIS,
            slot::IfcAxis2Placement3D::REF_DIRECTION,
        ] {
            let value = placement.attr(axis)?;
            if matches!(value, AttributeValue::Null) {
                continue;
            }
            let direction = self.decode_by_id(value.as_entity_ref()?).ok()?;
            if direction.ifc_type != IfcType::IfcDirection {
                return Some(false);
            }
            let ratios = direction
                .attr(slot::IfcDirection::DIRECTION_RATIOS)?
                .as_list()?;
            if ratios.len() != 3
                || ratios
                    .iter()
                    .any(|v| v.as_float().is_none_or(|v| !v.is_finite()))
                || !ratios
                    .iter()
                    .any(|v| v.as_float().is_some_and(|v| v != 0.0))
            {
                return Some(false);
            }
        }
        Some(true)
    }

    fn certified_si_length(&mut self, project: &crate::DecodedEntity) -> Option<(u32, f64)> {
        let assignment = self
            .decode_by_id(project.ref_at(slot::IfcProject::UNITS_IN_CONTEXT)?)
            .ok()?;
        if assignment.ifc_type != IfcType::IfcUnitAssignment {
            return None;
        }
        let mut length = None;
        for value in assignment.attr(slot::IfcUnitAssignment::UNITS)?.as_list()? {
            let id = value.as_entity_ref()?;
            let unit = self.decode_by_id(id).ok()?;
            if matches!(
                unit.ifc_type,
                IfcType::IfcMonetaryUnit | IfcType::IfcDerivedUnit
            ) {
                continue;
            }
            if !unit.ifc_type.is_subtype_of(IfcType::IfcNamedUnit) {
                return None;
            }
            if unit.enum_at(slot::IfcNamedUnit::UNIT_TYPE)? != "LENGTHUNIT" {
                continue;
            }
            if length.is_some()
                || unit.ifc_type != IfcType::IfcSIUnit
                || unit.enum_at(slot::IfcSIUnit::NAME) != Some("METRE")
            {
                return None;
            }
            let prefix = unit.attr(slot::IfcSIUnit::PREFIX)?;
            let scale = if matches!(prefix, AttributeValue::Null) {
                1.0
            } else {
                crate::units::try_si_prefix_multiplier(prefix.as_enum()?)?
            };
            length = Some((id, scale));
        }
        length
    }
}

fn certified_mapped_scale(entity: &crate::DecodedEntity, name: &str) -> Option<()> {
    // A source displacement must not be magnified beyond the
    // context declaration by a mapped scale in this domain.
    let scale_indices: &[usize] = match name {
        "IFCCARTESIANTRANSFORMATIONOPERATOR2D"
        | "IFCCARTESIANTRANSFORMATIONOPERATOR3D" => {
            &[slot::IfcCartesianTransformationOperator::SCALE.index()]
        }
        "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM" => &[
            slot::IfcCartesianTransformationOperator::SCALE.index(),
            slot::IfcCartesianTransformationOperator2DnonUniform::SCALE2.index(),
        ],
        "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM" => &[
            slot::IfcCartesianTransformationOperator::SCALE.index(),
            slot::IfcCartesianTransformationOperator3DnonUniform::SCALE2.index(),
            slot::IfcCartesianTransformationOperator3DnonUniform::SCALE3.index(),
        ],
        _ => return None,
    };
    for &index in scale_indices {
        let value = entity.get(index)?;
        if !value.is_null() && value.as_float() != Some(1.0) {
            return None;
        }
    }
    Some(())
}

#[cfg(test)]
#[path = "precision_certificate_tests.rs"]
mod tests;
