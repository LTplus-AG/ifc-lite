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
        // of synthetic vertices while marking the source preserved-only.
        let source_surface = surface.clone();
        let terrain_diagnostic =
            crate::terrain::adapt_faceless_tin(&mut surface, self.limits, self.cancelled)?;
        if terrain_diagnostic.is_some() {
            surface = source_surface;
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

    pub(super) fn finish(mut self) -> Result<LandXmlTinDocument> {
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
        Ok(LandXmlTinDocument {
            format: "landxml".to_owned(),
            schema: "LandXML-1.2".to_owned(),
            capabilities: LandXmlCapabilities {
                renderable_tin: self
                    .surfaces
                    .iter()
                    .any(|surface| surface.render_state == LandXmlRenderState::Rendered),
                preserved_only_surfaces: self
                    .surfaces
                    .iter()
                    .filter(|surface| surface.render_state != LandXmlRenderState::Rendered)
                    .count(),
                unknown_extensions: self.extensions.len(),
            },
            version: self.version,
            units: self.units,
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
        })
    }
}
