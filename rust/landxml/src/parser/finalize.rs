/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

impl Parser<'_> {
    pub(super) fn finish_surface(&mut self) -> Result<()> {
        let mut surface = self.surface.take().expect("surface closing");
        self.surface_ordinal += 1;
        let source_id = LandXmlSourceId(format!("landxml:surface:{}", self.surface_ordinal));
        for point in &mut surface.points {
            point.source_id = LandXmlSourceId(format!("{}:point:{}", source_id.0, point.id));
        }
        for point in &mut surface.source_data_points {
            point.source_id =
                LandXmlSourceId(format!("{}:source-point:{}", source_id.0, point.ordinal));
        }
        for (index, line) in surface.boundaries.iter_mut().enumerate() {
            line.source_id = LandXmlSourceId(format!("{}:boundary:{}", source_id.0, index + 1));
            line.ordinal = index + 1;
            line.point_source_ids = (0..line.points.len())
                .map(|point| LandXmlSourceId(format!("{}:point:{}", line.source_id.0, point + 1)))
                .collect();
        }
        for (index, line) in surface.breaklines.iter_mut().enumerate() {
            line.source_id = LandXmlSourceId(format!("{}:breakline:{}", source_id.0, index + 1));
            line.ordinal = index + 1;
            line.point_source_ids = (0..line.points.len())
                .map(|point| LandXmlSourceId(format!("{}:point:{}", line.source_id.0, point + 1)))
                .collect();
        }
        for (index, line) in surface.contours.iter_mut().enumerate() {
            line.source_id = LandXmlSourceId(format!("{}:contour:{}", source_id.0, index + 1));
            line.ordinal = index + 1;
            line.point_source_ids = (0..line.points.len())
                .map(|point| LandXmlSourceId(format!("{}:point:{}", line.source_id.0, point + 1)))
                .collect();
        }
        let authored_faces = !surface.faces.is_empty();
        // A refusal is source-preserving: do not retain a partial collection
        // of synthetic vertices while marking the source preserved-only. An
        // authored TIN cannot enter synthesis, so it never needs this second
        // complete surface allocation on the streamed handoff path.
        let source_surface = (!authored_faces).then(|| surface.clone());
        let terrain_diagnostic = crate::terrain::adapt_faceless_tin(
            &mut surface,
            &self.limits,
            self.cancelled,
            &mut self.faces_seen,
            &mut self.references,
            &mut self.work,
        )?;
        if terrain_diagnostic.is_some() {
            surface = source_surface.expect("only faceless TIN synthesis can refuse");
        }
        let topology_origin = if authored_faces {
            crate::LandXmlTopologyOrigin::AuthoredFaces
        } else if terrain_diagnostic.is_none() && !surface.faces.is_empty() {
            crate::LandXmlTopologyOrigin::ConstrainedTriangulation
        } else {
            crate::LandXmlTopologyOrigin::PreservedOnly
        };
        let render_state = match surface.kind {
            LandXmlSurfaceKind::Tin if surface.points.len() >= 3 && !surface.faces.is_empty() => {
                for face in &surface.faces {
                    for id in face {
                        if !surface.ids.contains(id) {
                            return Err(error(
                                Code::InvalidSemantic,
                                "face references unknown point",
                            ));
                        }
                    }
                }
                LandXmlRenderState::Rendered
            }
            LandXmlSurfaceKind::Tin => {
                if let Some(diagnostic) = &terrain_diagnostic {
                    self.warnings.push(format!(
                        "{}: {}",
                        diagnostic.code.as_str(),
                        diagnostic.message
                    ));
                }
                self.warnings.push(format!(
                    "TIN surface \"{}\" has no renderable topology; source data was preserved",
                    surface.name
                ));
                LandXmlRenderState::PreservedOnly
            }
            LandXmlSurfaceKind::Grid | LandXmlSurfaceKind::Volume => {
                let label = if surface.kind == LandXmlSurfaceKind::Grid {
                    "GRID"
                } else {
                    "volume"
                };
                self.warnings.push(format!(
                    "Preserved {label} surface \"{}\" without guessed topology",
                    surface.name
                ));
                LandXmlRenderState::PreservedOnly
            }
            LandXmlSurfaceKind::Other => {
                self.warnings.push(format!(
                    "Unsupported or undefined surface \"{}\" was preserved without rendering",
                    surface.name
                ));
                LandXmlRenderState::Unsupported
            }
        };
        let face_source_ids = (0..surface.faces.len())
            .map(|index| {
                LandXmlSourceId(format!(
                    "{}:{}:{}",
                    source_id.0,
                    if topology_origin == crate::LandXmlTopologyOrigin::ConstrainedTriangulation {
                        "triangle"
                    } else {
                        "face"
                    },
                    index + 1,
                ))
            })
            .collect();
        self.surfaces.push(LandXmlSurface {
            source_id,
            ordinal: self.surface_ordinal,
            source_path: format!("LandXML/Surfaces/Surface[{}]", self.surface_ordinal),
            properties: surface.properties,
            definition_properties: surface.definition_properties,
            name: surface.name,
            kind: surface.kind,
            render_state,
            topology_origin,
            terrain_diagnostic,
            points: surface.points,
            canonical_vertices: surface.canonical_vertices,
            source_data_points: surface.source_data_points,
            faces: surface.faces,
            face_source_ids,
            face_visibility: surface.face_visibility,
            hidden_face_count: surface.hidden_face_count,
            boundaries: surface.boundaries,
            breaklines: surface.breaklines,
            contours: surface.contours,
        });
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<LandXmlTinDocument> {
        if self.version.is_empty() {
            return Err(error(Code::InvalidXml, "LandXML document is empty"));
        }
        if !self.extensions.is_empty() {
            self.warnings.push(format!(
                "Preserved {} unknown vendor extension root(s) as source metadata",
                self.extensions.len(),
            ));
        }
        self.finish_road_semantics()?;
        // #5175: renderable_tin already aggregates every surface that ever
        // reached `Rendered`, whether it is still resident in `self.surfaces`
        // (the non-streaming path) or was already drained out through
        // `take_surfaces` (the streaming path, tracked by
        // `drained_renderable_surfaces`). Gating on this single boolean, in
        // the one `finish` both `parse_landxml_tin_with_cancel` and
        // `LandXmlTinStreamSession::finish_cursor` call, is what makes the
        // units requirement agree across both entry points.
        let renderable_tin = self.drained_renderable_surfaces > 0
            || self
                .surfaces
                .iter()
                .any(|surface| surface.render_state == LandXmlRenderState::Rendered);
        // #5175: the units gate keys on whether anything is actually DRAWN,
        // which is narrower than `renderable_tin`. A TIN whose faces are all
        // hidden (`<F i="true">`) is still `Rendered`, but it puts no geometry
        // on screen, so demanding a unit for it would refuse a document #5042
        // deliberately preserves. `renderable_tin` keeps its published
        // capability meaning and is intentionally NOT narrowed here.
        let draws_to_scale = self.drained_drawing_surfaces > 0
            || self.surfaces.iter().any(surface_draws_to_scale);
        // `effective_units` folds in a caller-supplied assumed unit only when
        // the source never declared its own; a declared `<Units>` element is
        // always `self.units` and always wins.
        let effective_units = self.effective_units();
        require_units_for_renderable_tin(draws_to_scale, effective_units.as_ref())?;
        Ok(LandXmlTinDocument {
            format: "landxml".to_owned(),
            schema: self.schema,
            capabilities: LandXmlCapabilities {
                renderable_tin,
                preserved_only_surfaces: self.drained_preserved_surfaces
                    + self
                        .surfaces
                        .iter()
                        .filter(|surface| surface.render_state != LandXmlRenderState::Rendered)
                        .count(),
                unknown_extensions: self.extensions.len(),
            },
            version: self.version,
            units: effective_units,
            coordinate_system: self.coordinate_system,
            surfaces: self.surfaces,
            extensions: self.extensions,
            warnings: self.warnings,
            alignments: self.alignments,
            profiles: self.profiles,
            cross_sections: self.cross_sections,
            cross_section_surfaces: self.cross_section_surfaces,
            roadways: self.roadways,
            capability_diagnostics: self.capability_diagnostics,
            preserved_only_extensions: self.preserved_only_extensions,
            pipe_networks: None,
        })
    }
}

/// #5175: a surface draws to scale only when it is renderable AND at least one
/// of its faces is visible. `<F i="true">` marks a face hidden; a surface whose
/// faces are all hidden produces no geometry, so it needs no declared unit —
/// see the `#5042` "preserves an empty or fully hidden TIN" contract. Both the
/// non-streaming `finish` and the streaming per-surface drain use this, so they
/// cannot disagree about what "needs units" means.
pub(crate) fn surface_draws_to_scale(surface: &LandXmlSurface) -> bool {
    surface.render_state == LandXmlRenderState::Rendered
        && surface.faces.len() > surface.hidden_face_count
}

/// #5175: the single implementation of "a renderable numeric TIN surface
/// requires declared `<Units>`" (LXML009). A surface that is not renderable
/// (preserved-only, faceless-refused, or a non-TIN kind) never needs units to
/// stay inspectable — only `render_state == Rendered` triggers this.
///
/// Both parse paths call this instead of keeping their own copy of the rule:
/// [`Parser::finish`] (shared by the non-streaming entry point and by
/// [`crate::stream::LandXmlTinStreamSession::finish_cursor`]) and the
/// streaming session's per-surface drain in `stream::output`, which calls it
/// early so a surface never leaves the parser before units are known to be
/// missing.
///
/// #5175: `units` is the caller's *effective* units
/// ([`Parser::effective_units`]) — a declared `<Units>` element when present,
/// else a caller-supplied assumed unit
/// (`LandXmlLimits::assumed_linear_unit`), else `None`. This function does
/// not know or care which of the two it received; that distinction lives on
/// [`crate::LandXmlUnits::assumed`] for downstream consumers.
pub(crate) fn require_units_for_renderable_tin(
    renderable: bool,
    units: Option<&crate::LandXmlUnits>,
) -> Result<()> {
    if renderable && units.is_none() {
        return Err(error(
            Code::InvalidSemantic,
            "a numeric, renderable TIN surface requires a LandXML/Units element with a linearUnit attribute",
        ));
    }
    Ok(())
}
