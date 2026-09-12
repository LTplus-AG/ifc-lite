// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{
    authored::{self, refs, vector, Metadata},
    canonical,
    pdf_fill_provenance::Provenance,
    pdf_fill_types::*,
};
use ifc_lite_core::{AttributeValue as A, IfcType};
use rustc_hash::FxHashMap;
use sha2::{Digest, Sha256};

pub(super) const ALGORITHM: &str = "ifclite-pdf-fill-annotation-v1";

/// Create opaque polygonal fill pages through canonical product authoring and
/// geometry. An exact page converts as is; a page with visible unsupported
/// content converts only when the request quotes its fidelity report digest,
/// and the omissions are recorded with the annotation. Raster-only pages and
/// geometric qualification failures refuse the whole page.
pub fn plan_pdf_fill_annotation(
    bytes: &[u8],
    r: &PdfFillAnnotationRequest,
) -> Result<PdfFillAnnotationPlan, String> {
    let prepared = crate::pdf_vector::prepare_pdf_vector_page(&r.page)?;
    let fidelity = &prepared.fidelity;
    if let Some(accepted) = &r.accepted_fidelity_sha256 {
        if *accepted != fidelity.sha256 {
            return Err("Accepted PDF fidelity report does not match this page; review the current report".into());
        }
    }
    let accept_partial = r.accepted_fidelity_sha256.is_some();
    let geometry = crate::pdf_vector::fills::compose(&prepared, r.page.model_metres_from_pdf, accept_partial)?;
    let extra_global_ids = [r.property_set_global_id.as_str(), r.property_relation_global_id.as_str()];
    let metadata = Metadata {
        schema: &r.schema,
        source_revision: &r.source_revision,
        next_express_id: r.next_express_id,
        container_id: r.container_id,
        global_id: &r.global_id,
        containment_global_id: &r.containment_global_id,
        extra_global_ids: &extra_global_ids,
        name: &r.name,
    };
    let provenance = Provenance {
        request: r,
        prepared: &prepared,
        grid_size_metres: geometry.grid_metres,
        fill_regions: geometry.shapes.len(),
    };
    let mut reserve = 9usize + provenance.reserve();
    for shape in &geometry.shapes {
        reserve = reserve
            .checked_add(4 + shape.rings.len() + shape.rings.iter().map(Vec::len).sum::<usize>())
            .ok_or("PDF annotation entity budget overflow")?;
    }
    let authored::Authoring {
        mut author,
        mut source,
        placement,
        context_id,
        owner,
        scale,
        rtc_offset,
    } = authored::prepare(bytes, &metadata, &r.frame, reserve)?;
    let mut items = Vec::new();
    let mut styled = Vec::new();
    let mut regions = Vec::new();
    for shape in &geometry.shapes {
        let mut boundaries = Vec::new();
        for ring in &shape.rings {
            let mut points = Vec::new();
            for point in ring {
                points.push(author.add(
                    IfcType::IfcCartesianPoint,
                    vec![vector([point[0] / scale, point[1] / scale, 0.])],
                ));
            }
            points.push(*points.first().ok_or("PDF fill has an empty boundary")?);
            boundaries.push(author.add(IfcType::IfcPolyline, vec![refs(&points)]));
        }
        let item = author.add(
            IfcType::IfcAnnotationFillArea,
            vec![
                A::EntityRef(boundaries[0]),
                if boundaries.len() == 1 {
                    A::Null
                } else {
                    refs(&boundaries[1..])
                },
            ],
        );
        let rgb = shape.rgb;
        let color = author.add(
            IfcType::IfcColourRgb,
            vec![
                A::Null,
                A::Float(rgb[0]),
                A::Float(rgb[1]),
                A::Float(rgb[2]),
            ],
        );
        let style = author.add(
            IfcType::IfcFillAreaStyle,
            vec![
                A::String("PDF solid fill".into()),
                refs(&[color]),
                A::Enum("T".into()),
            ],
        );
        styled.push((
            item,
            author.add(
                IfcType::IfcStyledItem,
                vec![A::EntityRef(item), refs(&[style]), A::Null],
            ),
        ));
        items.push(item);
        regions.push(PdfFillRegion {
            geometry_item_id: item,
            source_operator_ordinal: shape.ordinal,
            rgb,
        });
    }
    let shape = author.add(
        IfcType::IfcShapeRepresentation,
        vec![
            A::EntityRef(context_id),
            A::String("Annotation".into()),
            A::String("Annotation2D".into()),
            refs(&items),
        ],
    );
    let pds = author.add(
        IfcType::IfcProductDefinitionShape,
        vec![A::Null, A::Null, refs(&[shape])],
    );
    let mut attrs = vec![
        A::String(r.global_id.clone()),
        owner.clone(),
        A::String(r.name.clone()),
        A::String(format!("PDF vectors, page {}: {}", r.page.page_number, fidelity.describe())),
        A::String("IfcLite:PdfVectorFills".into()),
        A::EntityRef(placement),
        A::EntityRef(pds),
    ];
    if r.schema == "IFC4X3" {
        attrs.push(A::Enum("USERDEFINED".into()));
    }
    let annotation = author.add(IfcType::IfcAnnotation, attrs);
    author.add(
        IfcType::IfcRelContainedInSpatialStructure,
        vec![
            A::String(r.containment_global_id.clone()),
            owner.clone(),
            A::Null,
            A::Null,
            refs(&[annotation]),
            A::EntityRef(r.container_id),
        ],
    );
    let property_set_id = provenance.author(&mut author, &owner, annotation)?;
    if author.plan.created.len() != reserve {
        return Err("PDF annotation allocation preflight disagrees with authored rows".into());
    }
    source.decoder.inject_shared_cache(&author.entities);
    let mut styles = crate::prepass::ResolvedPrepass::default();
    for (item, styled) in styled {
        let info = crate::style::fill::fill_style_from_styled_item(
            &author.entities[&styled],
            &mut source.decoder,
        )
        .ok_or("Generated PDF fill failed canonical style resolution")?;
        styles.geometry_style_index.insert(item, info);
    }
    let meshes = canonical::produce(
        &mut source,
        annotation,
        &FxHashMap::default(),
        Some(&styles),
    )?;
    if meshes.len() != items.len()
        || items.iter().any(|item| {
            meshes
                .iter()
                .filter(|m| m.geometry_item_id == Some(*item))
                .count()
                != 1
        })
        || meshes.iter().any(|m| {
            m.indices.is_empty() || m.positions.iter().chain(&m.normals).any(|v| !v.is_finite())
        })
    {
        return Err(
            "Canonical PDF annotation geometry lost or combined a visible fill region".into(),
        );
    }
    // Explicit transport limits, independent of contour and work budgets. The
    // host mirrors these before staging a multi-part annotation owner.
    if meshes.iter().map(|m| m.positions.len() / 3).sum::<usize>() > 65_536
        || meshes.iter().map(|m| m.indices.len() / 3).sum::<usize>() > 131_072
    {
        return Err("PDF annotation exceeds emitted mesh transport budget".into());
    }
    let mut geometry_work = geometry.work;
    for (shape, region) in geometry.shapes.iter().zip(&regions) {
        let mesh = meshes
            .iter()
            .find(|m| m.geometry_item_id == Some(region.geometry_item_id))
            .ok_or("Missing PDF fill mesh")?;
        let expected: Vec<[f64; 3]> = shape
            .rings
            .iter()
            .flatten()
            .map(|p| {
                std::array::from_fn(|i| {
                    r.frame.origin[i] + r.frame.axis_u[i] * p[0] + r.frame.axis_v[i] * p[1]
                })
            })
            .collect();
        let actual: Vec<[f64; 3]> = mesh
            .positions
            .chunks_exact(3)
            .map(|p| std::array::from_fn(|i| f64::from(p[i]) + mesh.origin[i] + rtc_offset[i]))
            .collect();
        geometry_work = geometry_work
            .checked_add((expected.len() as u64) * (actual.len() as u64) * 2)
            .ok_or("PDF fill precision work overflow")?;
        if geometry_work > 4_000_000 {
            return Err("PDF fill canonical precision check exceeds shared work budget".into());
        }
        let tolerance2 = r.page.tolerance_metres * r.page.tolerance_metres;
        let near = |a: &[f64; 3], b: &[f64; 3]| {
            a.iter().zip(b).map(|(a, b)| (a - b) * (a - b)).sum::<f64>() <= tolerance2
        };
        if expected.iter().any(|p| !actual.iter().any(|q| near(p, q)))
            || actual.iter().any(|p| !expected.iter().any(|q| near(p, q)))
        {
            return Err("Canonical PDF fill vertices exceed the requested metric precision; move the page nearer the model origin".into());
        }
    }
    let source_ifc_sha256 = format!("{:x}", Sha256::digest(bytes));
    let mut digest = Sha256::new();
    digest.update(ALGORITHM.as_bytes());
    digest.update(b"\0");
    digest.update(source_ifc_sha256.as_bytes());
    digest.update(serde_json::to_vec(r).map_err(|e| e.to_string())?);
    Ok(PdfFillAnnotationPlan {
        plan: author.plan,
        annotation_id: annotation,
        property_set_id,
        meshes,
        coordinate_space: "ifc-z-up",
        rtc_offset,
        frame: r.frame.clone(),
        source_ifc_sha256,
        source_pdf_sha256: r.page.pdf_sha256.clone(),
        page_number: r.page.page_number,
        request_sha256: format!("{:x}", digest.finalize()),
        algorithm: ALGORITHM,
        calibration_key: r.page.calibration_key.clone(),
        tolerance_metres: r.page.tolerance_metres,
        grid_size_metres: geometry.grid_metres,
        geometry_work,
        regions,
        fidelity: prepared.fidelity,
    })
}

#[cfg(test)]
#[path = "pdf_fill_tests.rs"]
mod tests;
