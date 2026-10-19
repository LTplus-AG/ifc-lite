// SPDX-License-Identifier: MPL-2.0
//! Owned sampled section/ring placement before production cap/wall construction.
//! Lengths remain in file units. These are f64 sampled rings and section frames,
//! not analytic surfaces or final product placement/RTC output.
use super::sectioned_mesh::{
    clean_region, emit_caps, emit_side_walls, interpolate_section, place_section, same_topology,
    Section,
};
use super::sectioned_positions::PositionAlongDirectrix;
use super::{compute_frame, is_proper, lerp_position, subdivisions};
use crate::{
    alignment::{AlignmentCurve, AlignmentFrame},
    alignment_arc_length::ArcLengthMap,
    profiles::ProfileProcessor,
    Error, Mesh, Result, TessellationQuality,
};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
use nalgebra::Point3;

#[derive(Debug, Clone)]
pub(crate) struct SectionedPlan {
    sections: Vec<Section>,
    rings_3d: Vec<Vec<Vec<Vec<Point3<f64>>>>>,
    frames: Vec<AlignmentFrame>,
}

pub(super) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    profile_processor: &ProfileProcessor,
) -> Result<SectionedPlan> {
    let directrix_id = entity
        .get_ref(slot::IfcSectionedSolidHorizontal::DIRECTRIX.index())
        .ok_or_else(|| {
            Error::geometry("IfcSectionedSolidHorizontal missing Directrix".to_string())
        })?;

    let sections_attr = entity
        .get(slot::IfcSectionedSolidHorizontal::CROSS_SECTIONS.index())
        .ok_or_else(|| {
            Error::geometry("IfcSectionedSolidHorizontal missing CrossSections".to_string())
        })?;
    let sections_list = sections_attr
        .as_list()
        .ok_or_else(|| Error::geometry("CrossSections must be a list".to_string()))?;

    let positions_attr = entity
        .get(slot::IfcSectionedSolidHorizontal::CROSS_SECTION_POSITIONS.index())
        .ok_or_else(|| {
            Error::geometry("IfcSectionedSolidHorizontal missing CrossSectionPositions".to_string())
        })?;
    let positions_list = positions_attr
        .as_list()
        .ok_or_else(|| Error::geometry("CrossSectionPositions must be a list".to_string()))?;

    if sections_list.len() != positions_list.len() {
        return Err(Error::geometry(format!(
            "IfcSectionedSolidHorizontal: CrossSections ({}) and CrossSectionPositions ({}) \
             must have equal length",
            sections_list.len(),
            positions_list.len(),
        )));
    }
    if sections_list.len() < 2 {
        return Err(Error::geometry(
            "IfcSectionedSolidHorizontal needs at least 2 cross-sections to loft".to_string(),
        ));
    }

    let fixed_axis_vertical = entity
        .get_bool(slot::IfcSectionedSolidHorizontal::FIXED_AXIS_VERTICAL.index())
        .unwrap_or(true);

    let directrix_entity = decoder.decode_by_id(directrix_id)?;
    let alignment = AlignmentCurve::parse(&directrix_entity, decoder)?;

    // Every station draws on one composite budget, armed once per solid.
    profile_processor.arm_solid_budget();

    // Decode authored (section, position) pairs. A section is one region
    // per disjoint admitted profile area.
    let mut authored: Vec<(Section, PositionAlongDirectrix)> =
        Vec::with_capacity(sections_list.len());
    for (sec_attr, pos_attr) in sections_list.iter().zip(positions_list.iter()) {
        let sec_id = sec_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("CrossSection must be an entity reference".to_string())
        })?;
        let sec_entity = decoder.decode_by_id(sec_id)?;
        let section: Section = profile_processor
            .process_regions(&sec_entity, decoder, quality)?
            .into_iter()
            .filter_map(clean_region)
            .collect();
        if section.is_empty() {
            continue; // Skip degenerate profiles.
        }
        let pos_id = pos_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("CrossSectionPosition must be an entity reference".to_string())
        })?;
        let pos_entity = decoder.decode_by_id(pos_id)?;
        let position = PositionAlongDirectrix::parse(&pos_entity, decoder, &directrix_entity)?;
        authored.push((section, position));
    }

    if authored.len() < 2 {
        return Err(Error::geometry(
            "IfcSectionedSolidHorizontal: <2 valid stations after filtering degenerate \
             cross-sections — nothing to loft"
                .to_string(),
        ));
    }
    sample(
        authored,
        alignment.as_ref(),
        fixed_axis_vertical,
        quality,
        entity.id,
    )
}

fn sample(
    mut authored: Vec<(Section, PositionAlongDirectrix)>,
    alignment: Option<&AlignmentCurve>,
    fixed_axis_vertical: bool,
    quality: TessellationQuality,
    source_id: u32,
) -> Result<SectionedPlan> {
    let arc_map = if authored.iter().any(|(_, pos)| !pos.along_horizontal) {
        alignment.map(ArcLengthMap::new)
    } else {
        None
    };
    // Preserve the canonical NaN-last station order.
    authored.sort_by(|a, b| crate::cmp_f64_nan_last(a.1.distance_along, b.1.distance_along));

    // Walk authored pairs, subdividing intermediate stations
    // wherever the alignment curves significantly between them. The
    // subdivision counts come first: a loft of rings base did not sweep
    // (areas, holes) is refused on its placed-vertex count before any
    // sample is materialised or capped.
    let steps: Vec<usize> = (1..authored.len())
        .map(|i| {
            let (prev_pos, this_pos) = (&authored[i - 1].1, &authored[i].1);
            subdivisions(prev_pos, this_pos, alignment, arc_map.as_ref(), quality)
        })
        .collect();
    let points = |section: &Section| {
        section
            .iter()
            .map(crate::profiles::region_points)
            .sum::<usize>()
    };
    let placed = points(&authored[0].0)
        + (1..authored.len())
            .map(|i| steps[i - 1] * points(&authored[i - 1].0).max(points(&authored[i].0)))
            .sum::<usize>();
    let new_rings = authored
        .iter()
        .any(|(section, _)| crate::profiles::sweeps_new_rings(section));
    crate::profiles::check_sweep_vertices(placed, new_rings, source_id)?;

    let mut samples: Vec<(Section, PositionAlongDirectrix)> = Vec::new();
    samples.push(authored[0].clone());
    for i in 1..authored.len() {
        let (prev_prof, prev_pos) = (&authored[i - 1].0, authored[i - 1].1);
        let (this_prof, this_pos) = (&authored[i].0, authored[i].1);
        let n = steps[i - 1];
        for k in 1..n {
            let t = k as f64 / n as f64;
            let interp_profile = interpolate_section(prev_prof, this_prof, t);
            let interp_pos = lerp_position(&prev_pos, &this_pos, t);
            samples.push((interp_profile, interp_pos));
        }
        samples.push(authored[i].clone());
    }

    // Place every ring of every sample in 3D using the alignment frame
    // plus the IfcDistanceExpression offsets.
    let mut rings_3d = Vec::with_capacity(samples.len());
    let mut frames: Vec<AlignmentFrame> = Vec::with_capacity(samples.len());
    for (section, pos) in &samples {
        let frame = compute_frame(alignment, arc_map.as_ref(), pos, fixed_axis_vertical)?;
        rings_3d.push(place_section(section, &frame));
        frames.push(frame);
    }

    Ok(SectionedPlan {
        sections: samples.into_iter().map(|(section, _)| section).collect(),
        rings_3d,
        frames,
    })
}

impl SectionedPlan {
    pub(crate) fn evaluate(&self) -> Result<Mesh> {
        let Self {
            sections,
            rings_3d,
            frames,
        } = self;
        // Build the mesh: start cap, side walls between consecutive
        // rings, end cap. Topology change (varying region or ring vertex
        // counts between adjacent samples) closes the current sub-sweep
        // and reopens the next one with a backwards-facing cap. The cap's shading
        // normal is the directrix tangent direction at that station so
        // flat-shaded renderers don't sample the side-wall normal.
        let mut mesh = Mesh::new();
        let flip = !is_proper(&frames[0]);
        emit_caps(
            &mut mesh,
            &sections[0],
            &rings_3d[0],
            -frames[0].tangent,
            flip,
        )?;
        for i in 1..sections.len() {
            let prev_profile = &sections[i - 1];
            let this_profile = &sections[i];
            let prev_ring = &rings_3d[i - 1];
            let this_ring = &rings_3d[i];

            if same_topology(prev_profile, this_profile) {
                emit_side_walls(&mut mesh, this_profile, prev_ring, this_ring, flip);
            } else {
                // Topology change. Cap off the previous sub-sweep
                // (forward-facing) and reopen with a backwards-facing
                // cap on the new sub-sweep. (Only triggered by
                // authored topology changes — subdivision-introduced
                // sub-samples always match their neighbours.)
                emit_caps(
                    &mut mesh,
                    prev_profile,
                    prev_ring,
                    frames[i - 1].tangent,
                    !flip,
                )?;
                emit_caps(&mut mesh, this_profile, this_ring, -frames[i].tangent, flip)?;
            }
        }
        let last = sections.len() - 1;
        emit_caps(
            &mut mesh,
            &sections[last],
            &rings_3d[last],
            frames[last].tangent,
            !flip,
        )?;

        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "sectioned_plan_tests.rs"]
mod tests;
