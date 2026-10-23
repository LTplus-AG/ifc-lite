// SPDX-License-Identifier: MPL-2.0
//! Writing caller geometry as IFC records: a triangle mesh as a tessellated
//! representation item, an optional surface colour, the `Body` shape around
//! it, and the representation context it hangs from.
//!
//! The mesh item branches on what the SOURCE schema can express, never on a
//! conversion: IFC4 and later get an `IfcTriangulatedFaceSet`; IFC2X3, which
//! has no tessellated geometry, gets one `IfcFace` per triangle. Those faces
//! go into an `IfcFacetedBrep` only when the mesh is closed (every edge shared
//! by exactly two triangles), because a brep asserts a solid; an open mesh
//! becomes an `IfcShellBasedSurfaceModel` over an `IfcOpenShell` instead.
//!
//! The colour follows the same rule. IFC2X3's `IfcStyledItem.Styles` holds
//! `IfcPresentationStyleAssignment`s, so the surface style is wrapped in one
//! there; IFC4 deprecated the wrapper and takes the style directly.

use std::collections::{HashMap, HashSet};

use ifc_lite_geometry::math::v3::{cross, dot, norm, sub};

use crate::step_ids::IdAllocator;

use super::attrs::{attribute_index, build_record};
use super::index::FileIndex;
use super::placement::{axis_placement_records, fmt};
use super::props_synth::ref_list;
use super::types::{SurfaceColour, TriangleMesh};

const IDENTITY: [[f64; 4]; 4] = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];

/// Appends records in id order; every builder below writes through one.
pub(crate) struct Emit<'a> {
    pub(crate) schema: &'a str,
    pub(crate) ids: &'a mut IdAllocator,
    pub(crate) out: &'a mut Vec<(u32, String)>,
}

impl Emit<'_> {
    pub(crate) fn record(&mut self, entity: &str, fields: &[(&str, String)]) -> Result<u32, String> {
        let id = self.ids.allocate().ok_or("id space exhausted")?;
        self.out.push((id, build_record(self.schema, id, entity, fields)));
        Ok(id)
    }

    pub(crate) fn axis_placement(&mut self, matrix: &[[f64; 4]; 4]) -> Result<u32, String> {
        let (records, id) = axis_placement_records(matrix, self.ids)?;
        self.out.extend(records);
        Ok(id)
    }

    pub(crate) fn identity_placement(&mut self) -> Result<u32, String> {
        self.axis_placement(&IDENTITY)
    }
}

pub(crate) fn validate_mesh(m: &TriangleMesh) -> Result<(), String> {
    if m.triangles.is_empty() {
        return Err("a mesh needs at least one triangle".into());
    }
    if m.positions.iter().flatten().any(|v| !v.is_finite()) {
        return Err("a mesh position is not finite".into());
    }
    let n = m.positions.len();
    for (i, t) in m.triangles.iter().enumerate() {
        if t.iter().any(|&v| v as usize >= n) {
            return Err(format!("triangle {i} indexes past the {n} positions"));
        }
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
            return Err(format!("triangle {i} repeats a vertex"));
        }
        let [a, b, c] = t.map(|v| m.positions[v as usize]);
        let (e1, e2) = (sub(b, a), sub(c, a));
        // `!(x > eps)` also refuses a NaN that overflow produced.
        if !(norm(cross(e1, e2)) > 1e-12 * norm(e1) * norm(e2)) {
            return Err(format!("triangle {i} has no area"));
        }
    }
    Ok(())
}

pub(crate) fn validate_colour(c: &SurfaceColour) -> Result<(), String> {
    let in_unit = |v: f64| (0.0..=1.0).contains(&v);
    if !(c.rgb.iter().all(|&v| in_unit(v)) && in_unit(c.transparency)) {
        return Err("colour components and transparency must lie in 0..1".into());
    }
    Ok(())
}

/// The context new body geometry goes into: a `Body` subcontext if the
/// source has one, else its `Model` context, else its first 3D context.
/// `None` when there is none of those (a file with only a 2D `Plan`
/// context gets one synthesized).
pub(crate) fn find_body_context(index: &FileIndex, schema: &str, removed: &HashSet<u32>) -> Option<u32> {
    let live = |t: &'static str| {
        index.contexts.iter().copied().filter(move |id| !removed.contains(id) && index.type_of(*id).as_deref() == Some(t))
    };
    let three_dimensional = |id: u32| {
        attribute_index(schema, "IFCGEOMETRICREPRESENTATIONCONTEXT", "CoordinateSpaceDimension")
            .and_then(|i| crate::step_text::attribute_of(&index.raw_line(id)?, i))
            .is_some_and(|v| v.trim() == "3")
    };
    let labelled = |id: u32, attr: &str, label: &str| {
        let entity = index.type_of(id).unwrap_or_default();
        index.string_attr(schema, id, &entity, attr).as_deref() == Some(label)
    };
    live("IFCGEOMETRICREPRESENTATIONSUBCONTEXT")
        .find(|&id| labelled(id, "ContextIdentifier", "Body"))
        .or_else(|| live("IFCGEOMETRICREPRESENTATIONCONTEXT").find(|&id| labelled(id, "ContextType", "Model")))
        .or_else(|| live("IFCGEOMETRICREPRESENTATIONCONTEXT").find(|&id| three_dimensional(id)))
}

/// A minimal 3D `Model` context at the world origin, for a source with no
/// representation context at all. The caller attaches it to the project.
pub(crate) fn synthesize_context(emit: &mut Emit) -> Result<u32, String> {
    let wcs = emit.identity_placement()?;
    emit.record(
        "IFCGEOMETRICREPRESENTATIONCONTEXT",
        &[
            ("ContextType", "'Model'".into()),
            ("CoordinateSpaceDimension", "3".into()),
            ("Precision", "1.E-05".into()),
            ("WorldCoordinateSystem", format!("#{wcs}")),
        ],
    )
}

/// `item` as a product's body: styled with `colour` when given, wrapped in a
/// `Body` `IfcShapeRepresentation` of `rep_type` in `context`, wrapped in an
/// `IfcProductDefinitionShape`, whose id is returned.
pub(crate) fn body_shape(
    emit: &mut Emit,
    context: u32,
    item: u32,
    rep_type: &str,
    colour: Option<&SurfaceColour>,
) -> Result<u32, String> {
    if let Some(c) = colour {
        styled_item(emit, item, c)?;
    }
    let shape = emit.record(
        "IFCSHAPEREPRESENTATION",
        &[
            ("ContextOfItems", format!("#{context}")),
            ("RepresentationIdentifier", "'Body'".into()),
            ("RepresentationType", format!("'{rep_type}'")),
            ("Items", format!("(#{item})")),
        ],
    )?;
    emit.record("IFCPRODUCTDEFINITIONSHAPE", &[("Representations", format!("(#{shape})"))])
}

/// The mesh as one representation item, and the `RepresentationType` a
/// shape holding it declares.
pub(crate) fn mesh_item(emit: &mut Emit, m: &TriangleMesh) -> Result<(u32, &'static str), String> {
    let closed = is_closed(m);
    if ifc_lite_core::attribute_names_for_schema(emit.schema, "IFCTRIANGULATEDFACESET").is_some() {
        let coords = m
            .positions
            .iter()
            .map(|p| format!("({},{},{})", fmt(p[0]), fmt(p[1]), fmt(p[2])))
            .collect::<Vec<_>>()
            .join(",");
        let list = emit.record("IFCCARTESIANPOINTLIST3D", &[("CoordList", format!("({coords})"))])?;
        let index = m
            .triangles
            .iter()
            .map(|t| format!("({},{},{})", t[0] + 1, t[1] + 1, t[2] + 1))
            .collect::<Vec<_>>()
            .join(",");
        let set = emit.record(
            "IFCTRIANGULATEDFACESET",
            &[
                ("Coordinates", format!("#{list}")),
                ("Closed", if closed { ".T." } else { ".F." }.into()),
                ("CoordIndex", format!("({index})")),
            ],
        )?;
        return Ok((set, "Tessellation"));
    }

    let mut point_ids = Vec::with_capacity(m.positions.len());
    for p in &m.positions {
        point_ids.push(emit.record("IFCCARTESIANPOINT", &[("Coordinates", format!("({},{},{})", fmt(p[0]), fmt(p[1]), fmt(p[2])))])?);
    }
    let mut faces = Vec::with_capacity(m.triangles.len());
    for t in &m.triangles {
        let corners: Vec<u32> = t.iter().map(|&v| point_ids[v as usize]).collect();
        let lp = emit.record("IFCPOLYLOOP", &[("Polygon", ref_list(&corners))])?;
        let bound = emit.record("IFCFACEOUTERBOUND", &[("Bound", format!("#{lp}")), ("Orientation", ".T.".into())])?;
        faces.push(emit.record("IFCFACE", &[("Bounds", ref_list(&[bound]))])?);
    }
    if closed {
        let shell = emit.record("IFCCLOSEDSHELL", &[("CfsFaces", ref_list(&faces))])?;
        Ok((emit.record("IFCFACETEDBREP", &[("Outer", format!("#{shell}"))])?, "Brep"))
    } else {
        let shell = emit.record("IFCOPENSHELL", &[("CfsFaces", ref_list(&faces))])?;
        Ok((emit.record("IFCSHELLBASEDSURFACEMODEL", &[("SbsmBoundary", ref_list(&[shell]))])?, "SurfaceModel"))
    }
}

/// Closed when the mesh bounds a volume: every directed edge is used once
/// and its reverse once (a consistently wound, watertight surface), and the
/// enclosed signed volume is not zero (two copies of one sheet, wound
/// opposite ways, pass the edge test and enclose nothing).
fn is_closed(m: &TriangleMesh) -> bool {
    let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
    for t in &m.triangles {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *edges.entry((a, b)).or_default() += 1;
        }
    }
    let watertight = edges.iter().all(|(&(a, b), &n)| n == 1 && edges.get(&(b, a)) == Some(&1));
    let volume: f64 = m
        .triangles
        .iter()
        .map(|t| {
            let [a, b, c] = t.map(|v| m.positions[v as usize]);
            dot(a, cross(b, c))
        })
        .sum::<f64>()
        / 6.0;
    // Measured against the mesh's own size, not its distance from the
    // origin (the volume sum is translation-invariant for a closed mesh).
    let extent = (0..3)
        .map(|axis| {
            let (lo, hi) = m.positions.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[axis]), hi.max(p[axis])));
            hi - lo
        })
        .fold(0.0, f64::max);
    watertight && volume.abs() > 1e-12 * extent.powi(3)
}

pub(crate) fn styled_item(emit: &mut Emit, item: u32, c: &SurfaceColour) -> Result<u32, String> {
    let [r, g, b] = c.rgb;
    let colour = emit.record("IFCCOLOURRGB", &[("Red", fmt(r)), ("Green", fmt(g)), ("Blue", fmt(b))])?;
    let rendering = emit.record(
        "IFCSURFACESTYLERENDERING",
        &[
            ("SurfaceColour", format!("#{colour}")),
            ("Transparency", fmt(c.transparency)),
            ("ReflectanceMethod", ".NOTDEFINED.".into()),
        ],
    )?;
    let style = emit.record("IFCSURFACESTYLE", &[("Side", ".BOTH.".into()), ("Styles", ref_list(&[rendering]))])?;
    let styles = if crate::schema_convert::targets_ifc2x3(emit.schema) {
        emit.record("IFCPRESENTATIONSTYLEASSIGNMENT", &[("Styles", ref_list(&[style]))])?
    } else {
        style
    };
    emit.record("IFCSTYLEDITEM", &[("Item", format!("#{item}")), ("Styles", ref_list(&[styles]))])
}
