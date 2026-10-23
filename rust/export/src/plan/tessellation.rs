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

use super::placement::IDENTITY;

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
        .find(|&id| {
            // A subcontext has its parent's dimension.
            labelled(id, "ContextIdentifier", "Body")
                && attribute_index(schema, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT", "ParentContext")
                    .and_then(|i| index.attrs(id)?.into_iter().nth(i)?.scalar)
                    .is_some_and(|p| !removed.contains(&p) && three_dimensional(p))
        })
        .or_else(|| live("IFCGEOMETRICREPRESENTATIONCONTEXT").find(|&id| labelled(id, "ContextType", "Model") && three_dimensional(id)))
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

/// `items` as a product's body: each styled with `colour` when given, wrapped
/// in one `Body` `IfcShapeRepresentation` of `rep_type` in `context`, wrapped
/// in an `IfcProductDefinitionShape`, whose id is returned.
pub(crate) fn body_shape(
    emit: &mut Emit,
    context: u32,
    items: &[u32],
    rep_type: &str,
    colour: Option<&SurfaceColour>,
) -> Result<u32, String> {
    if let Some(c) = colour {
        for &item in items {
            styled_item(emit, item, c)?;
        }
    }
    let shape = emit.record(
        "IFCSHAPEREPRESENTATION",
        &[
            ("ContextOfItems", format!("#{context}")),
            ("RepresentationIdentifier", "'Body'".into()),
            ("RepresentationType", format!("'{rep_type}'")),
            ("Items", ref_list(items)),
        ],
    )?;
    emit.record("IFCPRODUCTDEFINITIONSHAPE", &[("Representations", format!("(#{shape})"))])
}

/// The mesh as one representation item, and the `RepresentationType` a
/// shape holding it declares.
pub(crate) fn mesh_item(emit: &mut Emit, m: &TriangleMesh) -> Result<(u32, &'static str), String> {
    let closed = is_closed(m);
    let triangles = &m.triangles;
    if ifc_lite_core::attribute_names_for_schema(emit.schema, "IFCTRIANGULATEDFACESET").is_some() {
        let coords = m
            .positions
            .iter()
            .map(|p| format!("({},{},{})", fmt(p[0]), fmt(p[1]), fmt(p[2])))
            .collect::<Vec<_>>()
            .join(",");
        let list = emit.record("IFCCARTESIANPOINTLIST3D", &[("CoordList", format!("({coords})"))])?;
        let index = triangles
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

    // Only the positions a triangle uses: a point nothing names would be an
    // orphan record.
    let mut used = vec![false; m.positions.len()];
    for &v in triangles.iter().flatten() {
        used[v as usize] = true;
    }
    let mut point_ids = vec![0u32; m.positions.len()];
    for (i, p) in m.positions.iter().enumerate().filter(|&(i, _)| used[i]) {
        point_ids[i] = emit.record("IFCCARTESIANPOINT", &[("Coordinates", format!("({},{},{})", fmt(p[0]), fmt(p[1]), fmt(p[2])))])?;
    }
    let mut faces = Vec::with_capacity(triangles.len());
    for t in triangles.iter() {
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
/// enclosed signed volume is positive. Two copies of one sheet, wound
/// opposite ways, pass the edge test and enclose nothing; a surface wound
/// inward encloses a negative volume and is written open rather than as an
/// inside-out solid.
fn is_closed(m: &TriangleMesh) -> bool {
    let mut edges: HashMap<(u32, u32), u32> = HashMap::new();
    for t in &m.triangles {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *edges.entry((a, b)).or_default() += 1;
        }
    }
    if !edges.iter().all(|(&(a, b), &n)| n == 1 && edges.get(&(b, a)) == Some(&1)) {
        return false;
    }
    // One shell: a closed shell is connected through its edges, so two
    // solids, apart or touching at a vertex, are written open rather than as
    // one invalid shell.
    let mut shells = ifc_lite_geometry::UnionFind::new(m.triangles.len());
    let mut first_on_edge: HashMap<(u32, u32), u32> = HashMap::new();
    for (i, t) in m.triangles.iter().enumerate() {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let other = *first_on_edge.entry((a.min(b), a.max(b))).or_insert(i as u32);
            shells.union(other, i as u32);
        }
    }
    if (1..m.triangles.len() as u32).any(|i| shells.find(i) != shells.find(0)) {
        return false;
    }
    let Some(origin) = m.triangles.first().map(|t| m.positions[t[0] as usize]) else { return false };
    // Relative to a vertex of the mesh: the sum is translation-invariant for a
    // closed mesh, and far from the origin (georeferenced coordinates) the
    // absolute products would round away a small solid's volume.
    let (mut volume, mut lo, mut hi) = (0.0, [f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for t in &m.triangles {
        let [a, b, c] = t.map(|v| sub(m.positions[v as usize], origin));
        volume += dot(a, cross(b, c));
        for p in [a, b, c] {
            for axis in 0..3 {
                lo[axis] = lo[axis].min(p[axis]);
                hi[axis] = hi[axis].max(p[axis]);
            }
        }
    }
    // Measured against the size of what the triangles use.
    let extent = (0..3).map(|axis| hi[axis] - lo[axis]).fold(0.0, f64::max);
    volume / 6.0 > 1e-12 * extent.powi(3)
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

#[cfg(test)]
mod tests {
    use super::is_closed;
    use crate::plan::types::TriangleMesh;

    fn tetrahedron(inward: bool) -> TriangleMesh {
        let mut triangles = vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];
        if inward {
            triangles.iter_mut().for_each(|t| t.swap(1, 2));
        }
        TriangleMesh { positions: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], triangles }
    }

    #[test]
    fn only_an_outward_watertight_mesh_is_closed() {
        assert!(is_closed(&tetrahedron(false)));
        assert!(!is_closed(&tetrahedron(true)), "inward winding would declare an inside-out solid");
        let mut sheet = tetrahedron(false);
        sheet.triangles.truncate(1);
        assert!(!is_closed(&sheet));
        let mut two = tetrahedron(false);
        two.positions.extend(two.positions.clone().iter().map(|p| [p[0] + 5.0, p[1], p[2]]));
        let shifted: Vec<[u32; 3]> = two.triangles.iter().map(|t| t.map(|v| v + 4)).collect();
        two.triangles.extend(shifted);
        assert!(!is_closed(&two), "two separate solids are not one closed shell");
        let mut bowtie = tetrahedron(false);
        bowtie.positions.extend([[0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, -1.0, 0.0]]);
        // The second solid is the first reflected through the origin's
        // shared vertex; its triangles are re-wound so it faces out too.
        let mirrored: Vec<[u32; 3]> =
            tetrahedron(false).triangles.iter().map(|t| t.map(|v| if v == 0 { 0 } else { v + 3 })).map(|[a, b, c]| [a, c, b]).collect();
        bowtie.triangles.extend(mirrored);
        assert!(!is_closed(&bowtie), "two solids touching at a vertex are not one shell");
        assert!(!is_closed(&TriangleMesh { positions: Vec::new(), triangles: Vec::new() }));
    }

    /// Far from the origin the absolute products round away a small solid's
    /// volume; measured from one of its own vertices it stays exact enough.
    #[test]
    fn a_small_solid_far_from_the_origin_is_still_closed() {
        let mut m = tetrahedron(false);
        for p in &mut m.positions {
            *p = [p[0] * 0.3 + 2_600_123.456, p[1] * 0.3 + 1_200_456.789, p[2] * 0.3 + 432.1];
        }
        assert!(is_closed(&m));
        let mut inward = m.clone();
        inward.triangles.iter_mut().for_each(|t| t.swap(1, 2));
        assert!(!is_closed(&inward));
    }
}
