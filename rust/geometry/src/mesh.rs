// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh data structures

use nalgebra::{Point3, Vector3};

/// Coordinate shift for RTC (Relative-to-Center) rendering
/// Stores the offset subtracted from coordinates to improve Float32 precision
#[derive(Debug, Clone, Copy, Default)]
pub struct CoordinateShift {
    /// X offset (subtracted from all X coordinates)
    pub x: f64,
    /// Y offset (subtracted from all Y coordinates)
    pub y: f64,
    /// Z offset (subtracted from all Z coordinates)
    pub z: f64,
}

impl CoordinateShift {
    /// Create a new coordinate shift
    #[inline]
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    /// Create shift from a Point3
    #[inline]
    pub fn from_point(point: Point3<f64>) -> Self {
        Self {
            x: point.x,
            y: point.y,
            z: point.z,
        }
    }

    /// Check if shift is significant (>10km from origin)
    #[inline]
    pub fn is_significant(&self) -> bool {
        const THRESHOLD: f64 = 10000.0; // 10km
        self.x.abs() > THRESHOLD || self.y.abs() > THRESHOLD || self.z.abs() > THRESHOLD
    }

    /// Check if shift is zero (no shifting needed)
    #[inline]
    pub fn is_zero(&self) -> bool {
        self.x == 0.0 && self.y == 0.0 && self.z == 0.0
    }
}

/// Side-channel instancing metadata, attached only when GPU instancing is
/// enabled (the `IFC_LITE_INSTANCING` flag). NEVER read by geometry processing
/// and excluded from `compute_mesh_hash` / `meshes_equal`, so content-dedup and
/// the default flat path are unaffected. The native helper collates occurrences
/// into unique geometry + per-instance transforms. Reconstruction contract:
/// `world = (transform . local_transform) * canonical_local_vertex - rtc_offset`.
#[derive(Debug, Clone)]
pub struct InstanceMeta {
    /// Full world placement (parent . local, scaled), pre-RTC, row-major homogeneous.
    pub transform: [f64; 16],
    /// IfcMappedItem mapping_transform (scaled), composed after `transform`.
    pub local_transform: Option<[f64; 16]>,
    /// Rigid-congruence canonical→local transform `C_k` (row-major), set by the
    /// rotation-normalized tier (`IFC_LITE_RIGID_INSTANCING`) when this mesh was
    /// grouped to a congruent-but-not-identical template. `None` ⇒ identity (the
    /// exact-bit tier). Composed innermost: world = transform · local · canonical.
    pub canonical_transform: Option<[f64; 16]>,
    /// Representation-identity key: RepresentationMap id (mapped) or geometry hash (direct).
    pub rep_identity: u128,
    /// Whether this mesh is provably shareable (not void-cut / not site-rotated).
    pub instanceable: bool,
}

/// Triangle mesh
#[derive(Debug, Clone)]
pub struct Mesh {
    /// Vertex positions (x, y, z)
    pub positions: Vec<f32>,
    /// Vertex normals (nx, ny, nz)
    pub normals: Vec<f32>,
    /// Triangle indices (i0, i1, i2)
    pub indices: Vec<u32>,
    /// Whether RTC offset has already been subtracted from positions.
    /// Set by `FacetedBrepProcessor::process_with_rtc` to prevent
    /// `transform_mesh` from double-subtracting RTC.
    pub rtc_applied: bool,
    /// Per-mesh local origin (f64), in the RTC/world frame. When non-zero,
    /// `positions` are stored RELATIVE to this origin (so they stay small and
    /// f32-precise regardless of the element's world placement), and the world
    /// position of a vertex is `origin + position`. Set by `transform_mesh_world`
    /// to the element's centroid so building-scale coordinates (~hundreds of
    /// metres) never collapse adjacent vertices to bit-identical f32. Default
    /// `[0, 0, 0]` means positions are already absolute (legacy/local meshes).
    pub origin: [f64; 3],
    /// Instancing side-channel (see [`InstanceMeta`]); `None` on the flat path.
    pub instance_meta: Option<InstanceMeta>,
}

/// A sub-mesh with its source geometry item ID.
/// Used to track which geometry items contribute to an element's mesh,
/// allowing per-item color/style lookup.
#[derive(Debug, Clone)]
pub struct SubMesh {
    /// The geometry item ID (e.g., IfcFacetedBrep ID) for style lookup
    pub geometry_id: u32,
    /// The triangulated mesh data
    pub mesh: Mesh,
}

impl SubMesh {
    /// Create a new sub-mesh
    pub fn new(geometry_id: u32, mesh: Mesh) -> Self {
        Self { geometry_id, mesh }
    }
}

/// Collection of sub-meshes from an element, preserving per-item identity
#[derive(Debug, Clone, Default)]
pub struct SubMeshCollection {
    pub sub_meshes: Vec<SubMesh>,
}

impl SubMeshCollection {
    /// Create a new empty collection
    pub fn new() -> Self {
        Self {
            sub_meshes: Vec::new(),
        }
    }

    /// Add a sub-mesh
    pub fn add(&mut self, geometry_id: u32, mesh: Mesh) {
        if !mesh.is_empty() {
            self.sub_meshes.push(SubMesh::new(geometry_id, mesh));
        }
    }

    /// Check if collection is empty
    pub fn is_empty(&self) -> bool {
        self.sub_meshes.is_empty()
    }

    /// Get number of sub-meshes
    pub fn len(&self) -> usize {
        self.sub_meshes.len()
    }

    /// Merge all sub-meshes into a single mesh (loses per-item identity)
    pub fn into_combined_mesh(self) -> Mesh {
        let mut combined = Mesh::new();
        for sub in self.sub_meshes {
            combined.merge(&sub.mesh);
        }
        combined
    }

    /// Iterate over sub-meshes
    pub fn iter(&self) -> impl Iterator<Item = &SubMesh> {
        self.sub_meshes.iter()
    }
}

impl Mesh {
    /// Create a new empty mesh
    pub fn new() -> Self {
        Self {
            positions: Vec::new(),
            normals: Vec::new(),
            indices: Vec::new(),
            rtc_applied: false,
            origin: [0.0; 3],
            instance_meta: None,
        }
    }

    /// Create a mesh with capacity
    pub fn with_capacity(vertex_count: usize, index_count: usize) -> Self {
        Self {
            positions: Vec::with_capacity(vertex_count * 3),
            normals: Vec::with_capacity(vertex_count * 3),
            indices: Vec::with_capacity(index_count),
            rtc_applied: false,
            origin: [0.0; 3],
            instance_meta: None,
        }
    }

    /// Create a mesh from a single triangle
    pub fn from_triangle(
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        normal: &Vector3<f64>,
    ) -> Self {
        let mut mesh = Self::with_capacity(3, 3);
        mesh.positions = vec![
            v0.x as f32,
            v0.y as f32,
            v0.z as f32,
            v1.x as f32,
            v1.y as f32,
            v1.z as f32,
            v2.x as f32,
            v2.y as f32,
            v2.z as f32,
        ];
        mesh.normals = vec![
            normal.x as f32,
            normal.y as f32,
            normal.z as f32,
            normal.x as f32,
            normal.y as f32,
            normal.z as f32,
            normal.x as f32,
            normal.y as f32,
            normal.z as f32,
        ];
        mesh.indices = vec![0, 1, 2];
        mesh
    }

    /// Add a vertex with normal
    #[inline]
    pub fn add_vertex(&mut self, position: Point3<f64>, normal: Vector3<f64>) {
        self.positions.push(position.x as f32);
        self.positions.push(position.y as f32);
        self.positions.push(position.z as f32);

        self.normals.push(normal.x as f32);
        self.normals.push(normal.y as f32);
        self.normals.push(normal.z as f32);
    }

    /// Apply coordinate shift to existing positions in-place
    /// Uses f64 intermediate for precision when subtracting large offsets
    #[inline]
    pub fn apply_shift(&mut self, shift: &CoordinateShift) {
        if shift.is_zero() {
            return;
        }
        for chunk in self.positions.chunks_exact_mut(3) {
            // Convert to f64, subtract, convert back to f32
            chunk[0] = (chunk[0] as f64 - shift.x) as f32;
            chunk[1] = (chunk[1] as f64 - shift.y) as f32;
            chunk[2] = (chunk[2] as f64 - shift.z) as f32;
        }
        self.rtc_applied = true;
    }

    /// Add a triangle
    #[inline]
    pub fn add_triangle(&mut self, i0: u32, i1: u32, i2: u32) {
        self.indices.push(i0);
        self.indices.push(i1);
        self.indices.push(i2);
    }

    /// Merge another mesh into this one.
    ///
    /// Positions are stored relative to `origin`. The common case is merging
    /// local/origin-zero meshes (sub-meshes combined BEFORE the world transform),
    /// where origins match and concatenation is exact. If the two meshes carry
    /// different non-zero origins, `other` is rebased into self's frame so the
    /// merged positions stay consistent (correct, though large-coordinate if the
    /// origins are far apart — which the pre-transform merge order avoids).
    #[inline]
    pub fn merge(&mut self, other: &Mesh) {
        if other.is_empty() {
            return;
        }
        if self.positions.is_empty() {
            self.origin = other.origin;
        }
        let d = [
            other.origin[0] - self.origin[0],
            other.origin[1] - self.origin[1],
            other.origin[2] - self.origin[2],
        ];

        let vertex_offset = (self.positions.len() / 3) as u32;

        // Pre-allocate for the incoming data
        self.positions.reserve(other.positions.len());
        self.normals.reserve(other.normals.len());
        self.indices.reserve(other.indices.len());

        if d == [0.0, 0.0, 0.0] {
            self.positions.extend_from_slice(&other.positions);
        } else {
            for chunk in other.positions.chunks_exact(3) {
                self.positions.push((chunk[0] as f64 + d[0]) as f32);
                self.positions.push((chunk[1] as f64 + d[1]) as f32);
                self.positions.push((chunk[2] as f64 + d[2]) as f32);
            }
        }
        self.normals.extend_from_slice(&other.normals);

        // Vectorized index offset - more cache-friendly than loop
        self.indices
            .extend(other.indices.iter().map(|&i| i + vertex_offset));

        // Preserve RTC state: if either mesh has RTC applied, the merged result does too
        if other.rtc_applied {
            self.rtc_applied = true;
        }
    }

    /// Batch merge multiple meshes at once (more efficient than individual merges)
    #[inline]
    pub fn merge_all(&mut self, meshes: &[Mesh]) {
        // Calculate total size needed
        let total_positions: usize = meshes.iter().map(|m| m.positions.len()).sum();
        let total_indices: usize = meshes.iter().map(|m| m.indices.len()).sum();

        // Reserve capacity upfront to avoid reallocations
        self.positions.reserve(total_positions);
        self.normals.reserve(total_positions);
        self.indices.reserve(total_indices);

        // Delegate to `merge` for origin reconciliation (positions are stored
        // relative to `origin`; a naive concat would be wrong across differing
        // origins).
        for mesh in meshes {
            self.merge(mesh);
        }
    }

    /// Get vertex count
    #[inline]
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    /// Get triangle count
    #[inline]
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// Uniform 1→4 midpoint subdivision applied `levels` times. Each triangle is
    /// split into four by its three edge midpoints; midpoint positions/normals are
    /// the f32 average of the edge endpoints (commutative ⇒ a shared edge yields
    /// the SAME midpoint from either adjacent triangle, so the result stays
    /// watertight once the kernel's interner welds coincident vertices).
    ///
    /// Purpose: a host face that is one or two huge triangles concentrates ALL of
    /// a wall's opening cuts onto it, so the exact arrangement re-triangulates a
    /// single triangle carrying dozens of constraint segments — O(k²) and, worse,
    /// dense enough that the batched N-ary subtract leaves unrecovered constraints
    /// and falls back to the O(N²) sequential path. Spreading the face into many
    /// small triangles localises each opening to a few of them (small k), so the
    /// batched cut recovers. `consolidate_coplanar` re-triangulates each coplanar
    /// group afterwards, so the extra interior vertices do not survive into the
    /// final mesh except where a hole boundary pins them.
    pub fn subdivided(&self, levels: usize) -> Mesh {
        let mut cur = self.clone();
        for _ in 0..levels {
            cur = cur.subdivide_once();
        }
        cur
    }

    fn subdivide_once(&self) -> Mesh {
        let vcount = self.positions.len() / 3;
        let has_normals = self.normals.len() == self.positions.len();
        let mut positions = self.positions.clone();
        let mut normals = if has_normals { self.normals.clone() } else { Vec::new() };
        let mut indices = Vec::with_capacity(self.indices.len() * 4);
        // Edge → midpoint vertex index, keyed by the ordered endpoint pair so the
        // two triangles sharing an edge reuse one midpoint (no T-junctions).
        let mut mid_of: rustc_hash::FxHashMap<(u32, u32), u32> = rustc_hash::FxHashMap::default();
        let mut midpoint = |a: u32, b: u32, positions: &mut Vec<f32>, normals: &mut Vec<f32>| -> u32 {
            let key = if a < b { (a, b) } else { (b, a) };
            if let Some(&m) = mid_of.get(&key) {
                return m;
            }
            let (ia, ib) = (a as usize * 3, b as usize * 3);
            let m = (positions.len() / 3) as u32;
            for k in 0..3 {
                positions.push((self.positions[ia + k] + self.positions[ib + k]) * 0.5);
            }
            if has_normals {
                // Average then re-normalise: the rest of the pipeline treats
                // stored normals as unit vectors. On a flat face both endpoints
                // share a normal so this is a no-op; only a midpoint on an edge
                // between non-coplanar facets needs the renormalisation (and a
                // degenerate near-zero average falls back to endpoint `a`).
                let mut n = [
                    (self.normals[ia] + self.normals[ib]) * 0.5,
                    (self.normals[ia + 1] + self.normals[ib + 1]) * 0.5,
                    (self.normals[ia + 2] + self.normals[ib + 2]) * 0.5,
                ];
                let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                if len > 1.0e-6 {
                    n = [n[0] / len, n[1] / len, n[2] / len];
                } else {
                    n = [self.normals[ia], self.normals[ia + 1], self.normals[ia + 2]];
                }
                normals.extend_from_slice(&n);
            }
            mid_of.insert(key, m);
            m
        };
        for tri in self.indices.chunks_exact(3) {
            let (a, b, c) = (tri[0], tri[1], tri[2]);
            if a as usize >= vcount || b as usize >= vcount || c as usize >= vcount {
                continue;
            }
            let ab = midpoint(a, b, &mut positions, &mut normals);
            let bc = midpoint(b, c, &mut positions, &mut normals);
            let ca = midpoint(c, a, &mut positions, &mut normals);
            // four sub-triangles, preserving the parent winding
            indices.extend_from_slice(&[a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca]);
        }
        Mesh {
            positions,
            normals,
            indices,
            rtc_applied: self.rtc_applied,
            origin: self.origin,
        instance_meta: None, }
    }

    /// Remove triangle indices that reference vertices beyond the positions array.
    /// This prevents panics from malformed IFC data (e.g. Revit exports with invalid indices).
    #[inline]
    pub fn validate_indices(&mut self) {
        let vertex_count = self.positions.len() / 3;
        if vertex_count == 0 {
            self.indices.clear();
            return;
        }
        let mut valid = Vec::with_capacity(self.indices.len());
        for chunk in self.indices.chunks(3) {
            if chunk.len() == 3
                && (chunk[0] as usize) < vertex_count
                && (chunk[1] as usize) < vertex_count
                && (chunk[2] as usize) < vertex_count
            {
                valid.extend_from_slice(chunk);
            }
        }
        self.indices = valid;
    }

    /// Drop triangles that collapsed into degenerate needles when the mesh was
    /// stored at f32 precision.
    ///
    /// At building-scale world coordinates (e.g. ~220 m) an f32 mantissa only
    /// resolves ~15 µm, so two genuinely-distinct vertices less than one ULP
    /// apart round to the *same* (or near-same) f32 value. The triangle that
    /// joined them becomes a zero-area sliver — and when its third vertex is far
    /// away, a long thin "fan" that visibly spans the model (the gross
    /// corruption seen on large georeferenced buildings).
    ///
    /// These slivers carry effectively no area, so the neighbouring triangles of
    /// the same face already cover the surface; removing them is visually
    /// lossless while eliminating the fans. The proper fix (local-frame / tiled
    /// vertex storage) keeps the vertices distinct in the first place; this is
    /// the backstop for meshes that still arrive degenerate.
    ///
    /// Conservative by design — only drops triangles that are *unambiguously*
    /// garbage: a bit-identical f32 vertex pair (exact zero area) or an aspect
    /// ratio (longest edge / shortest edge) above 1e5. Legitimate thin members
    /// (mullions, braces) sit far below that. Only `indices` change; the vertex
    /// buffer and per-vertex data are left intact, so the operation is
    /// deterministic and keeps vertex indices stable.
    pub fn drop_degenerate_triangles(&mut self) {
        if self.indices.len() < 3 {
            return;
        }
        const MAX_ASPECT: f64 = 1.0e5;
        let vertex_count = self.positions.len() / 3;
        let vert = |i: u32| -> Option<[f64; 3]> {
            let i = i as usize;
            if i >= vertex_count {
                return None;
            }
            Some([
                self.positions[i * 3] as f64,
                self.positions[i * 3 + 1] as f64,
                self.positions[i * 3 + 2] as f64,
            ])
        };
        let bits = |i: u32| -> [u32; 3] {
            let i = i as usize;
            [
                self.positions[i * 3].to_bits(),
                self.positions[i * 3 + 1].to_bits(),
                self.positions[i * 3 + 2].to_bits(),
            ]
        };
        let dist = |a: [f64; 3], b: [f64; 3]| -> f64 {
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        };

        let mut kept = Vec::with_capacity(self.indices.len());
        for tri in self.indices.chunks_exact(3) {
            let (ia, ib, ic) = (tri[0], tri[1], tri[2]);
            // Bit-identical f32 vertex pair → exact zero-area collapse.
            let (ba, bb, bc) = (bits(ia), bits(ib), bits(ic));
            if ba == bb || bb == bc || ba == bc {
                continue;
            }
            let (va, vb, vc) = match (vert(ia), vert(ib), vert(ic)) {
                (Some(a), Some(b), Some(c)) => (a, b, c),
                _ => continue, // out-of-range index: drop (matches validate_indices)
            };
            let e0 = dist(va, vb);
            let e1 = dist(vb, vc);
            let e2 = dist(vc, va);
            let min_edge = e0.min(e1).min(e2);
            let max_edge = e0.max(e1).max(e2);
            // Catastrophic needle: a sliver whose longest edge dwarfs its
            // shortest by >1e5. min_edge==0 is already handled by the bit check
            // above, so a finite ratio here means near-but-not-identical f32.
            if min_edge > 0.0 && max_edge / min_edge > MAX_ASPECT {
                continue;
            }
            kept.extend_from_slice(tri);
        }
        self.indices = kept;
    }

    /// Check if mesh is empty
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    /// Calculate bounds (min, max) - optimized with chunk iteration
    #[inline]
    pub fn bounds(&self) -> (Point3<f32>, Point3<f32>) {
        if self.is_empty() {
            return (Point3::origin(), Point3::origin());
        }

        let mut min = Point3::new(f32::MAX, f32::MAX, f32::MAX);
        let mut max = Point3::new(f32::MIN, f32::MIN, f32::MIN);

        // Use chunks for better cache locality
        self.positions.chunks_exact(3).for_each(|chunk| {
            let (x, y, z) = (chunk[0], chunk[1], chunk[2]);
            min.x = min.x.min(x);
            min.y = min.y.min(y);
            min.z = min.z.min(z);
            max.x = max.x.max(x);
            max.y = max.y.max(y);
            max.z = max.z.max(z);
        });

        (min, max)
    }

    /// Calculate centroid in f64 precision (for RTC offset calculation)
    /// Returns the average of all vertex positions
    #[inline]
    pub fn centroid_f64(&self) -> Point3<f64> {
        if self.is_empty() {
            return Point3::origin();
        }

        let mut sum = Point3::new(0.0f64, 0.0f64, 0.0f64);
        let count = self.positions.len() / 3;

        self.positions.chunks_exact(3).for_each(|chunk| {
            sum.x += chunk[0] as f64;
            sum.y += chunk[1] as f64;
            sum.z += chunk[2] as f64;
        });

        Point3::new(
            sum.x / count as f64,
            sum.y / count as f64,
            sum.z / count as f64,
        )
    }

    /// Clear the mesh
    #[inline]
    pub fn clear(&mut self) {
        self.positions.clear();
        self.normals.clear();
        self.indices.clear();
        self.rtc_applied = false;
        // Reset instancing metadata so a cleared+reused mesh can't carry stale
        // rep-identity / transform into unrelated geometry. (#1238 review)
        self.instance_meta = None;
    }

    /// Weld coincident vertices, preserving per-vertex normals.
    ///
    /// Returns a new mesh where vertices whose **position AND normal** both
    /// quantize to the same bucket are merged. Indices are remapped.
    /// Triangles that collapse to a degenerate edge or point (any two
    /// corners welded to the same vertex) are dropped.
    ///
    /// **Use this when shading must stay crisp.** A box corner shared by
    /// three faces has the same position but three different normals, so
    /// it stays as three vertices — flat shading and per-face colours
    /// survive the weld.
    ///
    /// `position_eps` and `normal_eps` are bucket sizes (in metres and
    /// normal-vector units respectively). 1 µm position / 1 mrad normal is
    /// usually right for IFC geometry: well below any meaningful BIM
    /// tolerance and below f32 precision at typical building scales.
    ///
    /// For watertight output that lets you compute volumes or run CSG,
    /// use [`Mesh::welded_by_position`] instead — it merges all vertices
    /// at the same position regardless of normal.
    pub fn welded(&self, position_eps: f32, normal_eps: f32) -> Mesh {
        weld_impl(self, position_eps, Some(normal_eps), /*average_normals=*/ false)
    }

    /// Weld vertices that share a position, regardless of normal.
    ///
    /// Returns a new mesh where vertices at the same position (within
    /// `position_eps`) collapse to one canonical vertex; the welded
    /// vertex's normal is the sum of contributing normals, re-normalized
    /// (or the first contributing normal if the sum is degenerate).
    /// Triangles that collapse to a degenerate edge or point are dropped.
    ///
    /// **Use this when you need a topologically connected, manifold-
    /// candidate mesh** — volume queries, CSG operands, watertight
    /// checks, mesh repair pipelines. Shading at sharp corners gets
    /// averaged; if you need crisp corners use [`Mesh::welded`] instead.
    ///
    /// `position_eps` is the bucket size in metres (1 µm is a safe
    /// default for IFC).
    pub fn welded_by_position(&self, position_eps: f32) -> Mesh {
        weld_impl(self, position_eps, None, /*average_normals=*/ true)
    }

    /// Drop triangles whose perpendicular height (= 2·area / longest edge) is
    /// below `h_eps` metres — i.e. genuinely-degenerate **collinear** slivers
    /// (three distinct but near-collinear vertices, zero area). These come from
    /// redundant collinear vertices in source brep faces / extrusion profiles
    /// triangulated as-is; vertex welding can't merge them (the vertices are
    /// distinct), so this catches them. At `h_eps` ≈ 15 µm — far below any real
    /// architectural feature — the dropped triangles carry no area, so the
    /// surrounding triangulation still covers the face (visually lossless,
    /// watertight-preserving). Only `indices` change.
    pub fn drop_thin_triangles(&mut self, h_eps: f64) {
        if self.indices.len() < 3 {
            return;
        }
        let vertex_count = self.positions.len() / 3;
        let p = |i: u32| -> [f64; 3] {
            let i = i as usize;
            [
                self.positions[i * 3] as f64,
                self.positions[i * 3 + 1] as f64,
                self.positions[i * 3 + 2] as f64,
            ]
        };
        let mut kept = Vec::with_capacity(self.indices.len());
        for tri in self.indices.chunks_exact(3) {
            if (tri[0] as usize) >= vertex_count
                || (tri[1] as usize) >= vertex_count
                || (tri[2] as usize) >= vertex_count
            {
                continue;
            }
            let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
            let d = |u: [f64; 3], v: [f64; 3]| {
                ((u[0] - v[0]).powi(2) + (u[1] - v[1]).powi(2) + (u[2] - v[2]).powi(2)).sqrt()
            };
            let longest = d(a, b).max(d(b, c)).max(d(c, a));
            if longest <= 0.0 {
                continue; // fully collapsed
            }
            let ux = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let vx = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let cr = [
                ux[1] * vx[2] - ux[2] * vx[1],
                ux[2] * vx[0] - ux[0] * vx[2],
                ux[0] * vx[1] - ux[1] * vx[0],
            ];
            let area = 0.5 * (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt();
            let height = 2.0 * area / longest;
            if height < h_eps {
                continue; // collinear / zero-area sliver
            }
            kept.extend_from_slice(tri);
        }
        self.indices = kept;
    }

    /// Mesh hygiene applied to every element mesh before it leaves the router.
    ///
    /// Restores the cleanup the pure-Rust pipeline lost when #1024 removed
    /// Manifold (which implicitly dropped degenerate output). Without it,
    /// redundant/near-collinear source vertices in faceted breps and extrusion
    /// profiles get triangulated into visible needle "spikes" and jagged
    /// silhouettes (the regression reported on large breps); BIMcollab and
    /// other viewers don't show them because they clean degenerates on import.
    ///
    /// Deliberately **does not weld vertices**. The pipeline emits per-face
    /// flat-shaded facet soup on purpose (each facet keeps its own vertices +
    /// normal so creases stay sharp — see issue #846); welding would share
    /// vertices across facets and re-smooth every crease. Instead we drop only
    /// the genuinely-degenerate triangles via
    /// [`drop_thin_triangles`](Self::drop_thin_triangles) below the kernel's
    /// reconcile grid (`1/65536 ≈ 15.3 µm`): coincident-pair needles (area 0)
    /// and collinear slivers (three distinct near-collinear vertices). The grid
    /// is the kernel's own representable resolution, so sub-grid triangles are
    /// degenerate by definition; measured triangle counts are flat from
    /// 10–50 µm and only start touching real geometry at ~100 µm (6.5× higher),
    /// confirming nothing real lives in that band. Positions/normals are left
    /// untouched, so it is visually lossless and bit-deterministic.
    ///
    /// The 15.3 µm threshold is most precise when applied in a small-magnitude
    /// (element-local) frame, where f32 positions resolve well below it — which
    /// the tessellation chokepoints honour (they clean *before* world
    /// placement). The void-cut output is cleaned in world coordinates (the cut
    /// runs there), so on a model georeferenced a few hundred metres to ~10 km
    /// from origin — below the RTC re-basing threshold — the f32 grid at that
    /// magnitude approaches the threshold and the margin near opening seams
    /// erodes slightly; the `longest <= 0` guard still catches full collapse at
    /// extreme scale. NaN/Inf triangles are kept (the comparison is false),
    /// i.e. non-finite geometry is left for upstream to handle, never dropped.
    pub fn clean_degenerate(&mut self) {
        // 1/65536 m — matches kernel::mesh_bridge::SNAP_GRID (power-of-two for
        // bit-determinism). Sub-grid triangles are below kernel resolution.
        const RECONCILE_GRID: f64 = 1.0 / 65536.0;
        self.drop_thin_triangles(RECONCILE_GRID);
    }

    /// Filter out triangles with edges exceeding the threshold
    /// This removes "stretched" triangles that span unreasonably large distances,
    /// which can occur when disconnected geometry is incorrectly merged.
    ///
    /// Uses a conservative threshold (500m) to only catch clearly broken geometry,
    /// not legitimate large elements like long beams or walls.
    ///
    /// # Arguments
    /// * `max_edge_length` - Maximum allowed edge length in meters (default: 500m)
    ///
    /// # Returns
    /// Number of triangles removed
    pub fn filter_stretched_triangles(&mut self, max_edge_length: f32) -> usize {
        if self.is_empty() {
            return 0;
        }

        let max_edge_sq = max_edge_length * max_edge_length;
        let mut valid_indices = Vec::new();
        let mut removed_count = 0;

        // Check each triangle
        for i in (0..self.indices.len()).step_by(3) {
            if i + 2 >= self.indices.len() {
                break;
            }
            let i0 = self.indices[i] as usize;
            let i1 = self.indices[i + 1] as usize;
            let i2 = self.indices[i + 2] as usize;

            if i0 * 3 + 2 >= self.positions.len()
                || i1 * 3 + 2 >= self.positions.len()
                || i2 * 3 + 2 >= self.positions.len()
            {
                // Invalid indices - skip
                removed_count += 1;
                continue;
            }

            let p0 = (
                self.positions[i0 * 3],
                self.positions[i0 * 3 + 1],
                self.positions[i0 * 3 + 2],
            );
            let p1 = (
                self.positions[i1 * 3],
                self.positions[i1 * 3 + 1],
                self.positions[i1 * 3 + 2],
            );
            let p2 = (
                self.positions[i2 * 3],
                self.positions[i2 * 3 + 1],
                self.positions[i2 * 3 + 2],
            );

            // Calculate squared edge lengths
            let edge01_sq = (p1.0 - p0.0).powi(2) + (p1.1 - p0.1).powi(2) + (p1.2 - p0.2).powi(2);
            let edge12_sq = (p2.0 - p1.0).powi(2) + (p2.1 - p1.1).powi(2) + (p2.2 - p1.2).powi(2);
            let edge20_sq = (p0.0 - p2.0).powi(2) + (p0.1 - p2.1).powi(2) + (p0.2 - p2.2).powi(2);

            // Check if any edge exceeds threshold
            if edge01_sq <= max_edge_sq && edge12_sq <= max_edge_sq && edge20_sq <= max_edge_sq {
                // Triangle is valid - keep it
                valid_indices.push(self.indices[i]);
                valid_indices.push(self.indices[i + 1]);
                valid_indices.push(self.indices[i + 2]);
            } else {
                // Triangle has stretched edge - remove it
                removed_count += 1;
            }
        }

        self.indices = valid_indices;
        removed_count
    }

    /// Drop triangles with ANY vertex outside `[min - pad, max + pad]`, then
    /// compact away the now-unreferenced vertices. Returns the count dropped.
    ///
    /// Boolean subtraction can only REMOVE material, so the cut of a host whose
    /// pre-cut AABB is `[min, max]` is mathematically contained in that AABB.
    /// A malformed cutter — self-intersecting, or carrying garbage vertices
    /// metres from the real opening (e.g. an exporter that welds stray points
    /// into a tessellated void, the multi-body-cutter case) — can make the
    /// exact mesh-arrangement leak a spurious far-flung "flap" triangle into the
    /// output: a visible spike poking metres out of the wall. Such a triangle
    /// only appears once a SECOND cutter perturbs the arrangement, so it slips
    /// past the per-cutter admission guards. Any output vertex beyond the host
    /// AABB (past `pad`, which absorbs kernel snap / f64→f32 round-trip jitter)
    /// is provably such an artifact, so the triangle is dropped and its orphaned
    /// vertices removed (they would otherwise skew `bounds()` and every
    /// AABB-derived consumer: framing, picking, clash, export).
    ///
    /// A no-op on clean cuts — when nothing lies outside, `positions`/`normals`
    /// are left bit-identical so the frozen snapshot corpus is unperturbed. Also
    /// a no-op in the degenerate case where EVERY triangle would be dropped (an
    /// upstream frame/placement bug, not a cut artifact): the mesh is preserved
    /// rather than silently emptied.
    pub fn clip_triangles_to_aabb(&mut self, min: [f32; 3], max: [f32; 3], pad: f32) -> usize {
        if self.indices.is_empty() {
            return 0;
        }
        let lo = [min[0] - pad, min[1] - pad, min[2] - pad];
        let hi = [max[0] + pad, max[1] + pad, max[2] + pad];
        let inside = |i: u32| -> bool {
            let b = i as usize * 3;
            let (x, y, z) = (self.positions[b], self.positions[b + 1], self.positions[b + 2]);
            x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2]
        };
        let tri_count = self.indices.len() / 3;
        let mut kept: Vec<u32> = Vec::with_capacity(self.indices.len());
        for t in self.indices.chunks_exact(3) {
            if inside(t[0]) && inside(t[1]) && inside(t[2]) {
                kept.extend_from_slice(t);
            }
        }
        let dropped = tri_count - kept.len() / 3;
        // No-op when nothing protrudes (bit-identical) or when the whole mesh
        // would vanish (preserve it — that signals a bug elsewhere, not a spike).
        if dropped == 0 || kept.is_empty() {
            return 0;
        }
        // Compact: remap referenced vertices, drop orphans.
        let has_normals = self.normals.len() == self.positions.len();
        let mut remap: Vec<i32> = vec![-1; self.positions.len() / 3];
        let mut new_pos: Vec<f32> = Vec::with_capacity(kept.len() * 3);
        let mut new_nrm: Vec<f32> = Vec::with_capacity(if has_normals { kept.len() * 3 } else { 0 });
        let mut new_idx: Vec<u32> = Vec::with_capacity(kept.len());
        for &i in &kept {
            let old = i as usize;
            let slot = if remap[old] < 0 {
                let n = (new_pos.len() / 3) as u32;
                remap[old] = n as i32;
                new_pos.extend_from_slice(&self.positions[old * 3..old * 3 + 3]);
                if has_normals {
                    new_nrm.extend_from_slice(&self.normals[old * 3..old * 3 + 3]);
                }
                n
            } else {
                remap[old] as u32
            };
            new_idx.push(slot);
        }
        self.positions = new_pos;
        if has_normals {
            self.normals = new_nrm;
        } else {
            // Per-vertex normal array was absent or already inconsistent; clear
            // it so a stale, mis-indexed buffer never ships downstream.
            self.normals.clear();
        }
        self.indices = new_idx;
        dropped
    }
}

impl Default for Mesh {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared welding implementation backing `Mesh::welded` and
/// `Mesh::welded_by_position`.
///
/// When `normal_eps` is `Some(eps)`, the dedupe key is
/// `(quantized_position, quantized_normal)` and `average_normals` is
/// ignored — the first encountered (position, normal) pair wins. When
/// `normal_eps` is `None`, the dedupe key is `quantized_position` only;
/// `average_normals=true` accumulates contributing normals into the
/// welded vertex and renormalizes at the end.
fn weld_impl(
    mesh: &Mesh,
    position_eps: f32,
    normal_eps: Option<f32>,
    average_normals: bool,
) -> Mesh {
    use rustc_hash::FxHashMap;

    let n_verts = mesh.positions.len() / 3;
    if n_verts == 0 {
        return Mesh::new();
    }

    let has_normals = mesh.normals.len() == mesh.positions.len();
    let pos_scale = 1.0 / position_eps.max(f32::MIN_POSITIVE);
    let q_pos = |v: f32| -> i64 { (v * pos_scale).round() as i64 };

    let nrm_scale = normal_eps.map(|e| 1.0 / e.max(f32::MIN_POSITIVE));
    let q_nrm = |v: f32| -> i64 {
        nrm_scale
            .map(|s| (v * s).round() as i64)
            .unwrap_or(0)
    };

    // Dedupe key. Pre-allocate to size 6 (pos + normal) — using a tuple
    // would require two distinct hash types; a small array keeps a single
    // hash map specialisation.
    type Key = [i64; 6];
    let mut canonical: FxHashMap<Key, u32> = FxHashMap::default();
    let mut old_to_new: Vec<u32> = Vec::with_capacity(n_verts);
    let mut new_positions: Vec<f32> = Vec::with_capacity(n_verts * 3);
    let mut new_normals: Vec<f32> = Vec::with_capacity(n_verts * 3);
    // For the average-normals path, accumulate the un-normalized sum so
    // a final pass can normalize. The sum buffer is parallel to
    // `new_positions` chunks.
    let mut normal_accum: Vec<(f64, f64, f64)> = Vec::new();
    if average_normals {
        normal_accum.reserve(n_verts);
    }

    for i in 0..n_verts {
        let px = mesh.positions[i * 3];
        let py = mesh.positions[i * 3 + 1];
        let pz = mesh.positions[i * 3 + 2];
        let (nx, ny, nz) = if has_normals {
            (
                mesh.normals[i * 3],
                mesh.normals[i * 3 + 1],
                mesh.normals[i * 3 + 2],
            )
        } else {
            (0.0, 0.0, 0.0)
        };
        let key: Key = [
            q_pos(px),
            q_pos(py),
            q_pos(pz),
            q_nrm(nx),
            q_nrm(ny),
            q_nrm(nz),
        ];

        if let Some(&new_idx) = canonical.get(&key) {
            old_to_new.push(new_idx);
            if average_normals {
                let slot = &mut normal_accum[new_idx as usize];
                slot.0 += nx as f64;
                slot.1 += ny as f64;
                slot.2 += nz as f64;
            }
        } else {
            let new_idx = (new_positions.len() / 3) as u32;
            canonical.insert(key, new_idx);
            old_to_new.push(new_idx);
            new_positions.push(px);
            new_positions.push(py);
            new_positions.push(pz);
            if has_normals {
                new_normals.push(nx);
                new_normals.push(ny);
                new_normals.push(nz);
            }
            if average_normals {
                normal_accum.push((nx as f64, ny as f64, nz as f64));
            }
        }
    }

    // For average-normals path: normalize the accumulated sums and
    // write them back over the first-vertex-wins values stored above.
    if average_normals && has_normals {
        new_normals.clear();
        new_normals.reserve(normal_accum.len() * 3);
        for (sx, sy, sz) in &normal_accum {
            let len_sq = sx * sx + sy * sy + sz * sz;
            if len_sq > 1e-24 {
                let inv = 1.0 / len_sq.sqrt();
                new_normals.push((*sx * inv) as f32);
                new_normals.push((*sy * inv) as f32);
                new_normals.push((*sz * inv) as f32);
            } else {
                // Degenerate accumulation (opposing normals cancelled);
                // fall back to a neutral up-Z so consumers don't see NaN.
                new_normals.push(0.0);
                new_normals.push(0.0);
                new_normals.push(1.0);
            }
        }
    }

    // Re-index triangles, dropping degenerates and out-of-bound input
    // triangles the same way `validate_indices` does so a malformed
    // input mesh weld-then-renders fine instead of panicking later.
    let mut new_indices: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    for chunk in mesh.indices.chunks_exact(3) {
        let i0_raw = chunk[0] as usize;
        let i1_raw = chunk[1] as usize;
        let i2_raw = chunk[2] as usize;
        if i0_raw >= n_verts || i1_raw >= n_verts || i2_raw >= n_verts {
            continue;
        }
        let i0 = old_to_new[i0_raw];
        let i1 = old_to_new[i1_raw];
        let i2 = old_to_new[i2_raw];
        if i0 == i1 || i1 == i2 || i0 == i2 {
            continue;
        }
        new_indices.push(i0);
        new_indices.push(i1);
        new_indices.push(i2);
    }

    Mesh {
        positions: new_positions,
        normals: new_normals,
        indices: new_indices,
        rtc_applied: mesh.rtc_applied,
        origin: mesh.origin,
    instance_meta: None, }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a mesh from explicit triangles (each tri = 3 xyz triples).
    fn mesh_from_tris(tris: &[[[f32; 3]; 3]]) -> Mesh {
        let mut m = Mesh::new();
        for (i, t) in tris.iter().enumerate() {
            for v in t {
                m.positions.extend_from_slice(v);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            let b = (i * 3) as u32;
            m.indices.extend_from_slice(&[b, b + 1, b + 2]);
        }
        m
    }

    #[test]
    fn clip_to_aabb_drops_protruding_flap_and_compacts() {
        // Two in-bounds triangles forming a unit quad in z=0, plus one spurious
        // "spike" flap whose apex pokes far below the host AABB (the malformed-
        // cutter artifact): apex at y = -5 while the host is y in [0,1].
        let mut m = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]],
            [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
            // spike: one vertex 5 m below the host
            [[1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.5, -5.0, 0.0]],
        ]);
        let dropped = m.clip_triangles_to_aabb([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], 0.01);
        assert_eq!(dropped, 1, "only the spike triangle should be dropped");
        assert_eq!(m.triangle_count(), 2);
        // Orphaned spike apex must be compacted away so bounds() is clean.
        let (lo, hi) = m.bounds();
        assert!(lo.y >= -0.01, "protruding apex left in positions: lo.y = {}", lo.y);
        let _ = hi;
        // 9 input verts (3 per tri, unshared) → after dropping the spike's 3 and
        // compacting the orphaned apex, the 2 kept tris keep their 6 verts.
        assert_eq!(m.positions.len() / 3, 6, "orphaned apex must be compacted out");
        assert_eq!(m.normals.len(), m.positions.len(), "normals stay in sync");
        // every surviving index is in range
        assert!(m.indices.iter().all(|&i| (i as usize) < m.positions.len() / 3));
    }

    #[test]
    fn clip_to_aabb_is_noop_when_nothing_protrudes() {
        let tris = [
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]],
            [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
        ];
        let mut m = mesh_from_tris(&tris);
        let before_pos = m.positions.clone();
        let before_idx = m.indices.clone();
        let dropped = m.clip_triangles_to_aabb([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], 0.01);
        assert_eq!(dropped, 0);
        // bit-identical: clean cuts must not perturb the frozen snapshot corpus
        assert_eq!(m.positions, before_pos);
        assert_eq!(m.indices, before_idx);
    }

    #[test]
    fn clip_to_aabb_preserves_mesh_when_all_would_drop() {
        // Degenerate guard: if EVERY triangle is outside (an upstream frame bug,
        // not a spike), preserve the mesh rather than silently emptying it.
        let mut m = mesh_from_tris(&[[
            [100.0, 100.0, 0.0],
            [101.0, 100.0, 0.0],
            [101.0, 101.0, 0.0],
        ]]);
        let dropped = m.clip_triangles_to_aabb([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], 0.01);
        assert_eq!(dropped, 0);
        assert_eq!(m.triangle_count(), 1, "mesh preserved, not emptied");
    }

    #[test]
    fn test_merge() {
        let mut mesh1 = Mesh::new();
        mesh1.add_vertex(Point3::new(0.0, 0.0, 0.0), Vector3::z());
        mesh1.add_triangle(0, 1, 2);

        let mut mesh2 = Mesh::new();
        mesh2.add_vertex(Point3::new(1.0, 1.0, 1.0), Vector3::y());
        mesh2.add_triangle(0, 1, 2);

        mesh1.merge(&mesh2);
        assert_eq!(mesh1.vertex_count(), 2);
        assert_eq!(mesh1.triangle_count(), 2);
    }

    #[test]
    fn test_coordinate_shift_creation() {
        let shift = CoordinateShift::new(500000.0, 5000000.0, 100.0);
        assert!(shift.is_significant());
        assert!(!shift.is_zero());

        let zero_shift = CoordinateShift::default();
        assert!(!zero_shift.is_significant());
        assert!(zero_shift.is_zero());
    }

    #[test]
    fn test_apply_shift_to_existing_mesh() {
        let mut mesh = Mesh::new();

        // Add vertices with large coordinates (already converted to f32 - some precision lost)
        mesh.positions = vec![500000.0, 5000000.0, 0.0, 500010.0, 5000010.0, 10.0];
        mesh.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0];

        // Apply shift
        let shift = CoordinateShift::new(500000.0, 5000000.0, 0.0);
        mesh.apply_shift(&shift);

        // Verify positions are shifted
        assert!((mesh.positions[0] - 0.0).abs() < 0.001);
        assert!((mesh.positions[1] - 0.0).abs() < 0.001);
        assert!((mesh.positions[3] - 10.0).abs() < 0.001);
        assert!((mesh.positions[4] - 10.0).abs() < 0.001);
    }

    #[test]
    fn test_centroid_f64() {
        let mut mesh = Mesh::new();
        mesh.positions = vec![0.0, 0.0, 0.0, 10.0, 10.0, 10.0, 20.0, 20.0, 20.0];
        mesh.normals = vec![0.0; 9];

        let centroid = mesh.centroid_f64();
        assert!((centroid.x - 10.0).abs() < 0.001);
        assert!((centroid.y - 10.0).abs() < 0.001);
        assert!((centroid.z - 10.0).abs() < 0.001);
    }

    #[test]
    fn test_precision_comparison_shifted_vs_unshifted() {
        // This test quantifies the precision improvement from shifting
        // Using Swiss UTM coordinates as example

        // Two points that are exactly 0.001m (1mm) apart
        let base_x = 2679012.0;
        let base_y = 1247892.0;
        let offset = 0.001; // 1mm

        let p1 = Point3::new(base_x, base_y, 0.0);
        let p2 = Point3::new(base_x + offset, base_y, 0.0);

        // Without shift - convert directly to f32
        let p1_f32_direct = (p1.x as f32, p1.y as f32);
        let p2_f32_direct = (p2.x as f32, p2.y as f32);
        let diff_direct = p2_f32_direct.0 - p1_f32_direct.0;

        // With shift - subtract centroid first, then convert
        let shift = CoordinateShift::new(base_x, base_y, 0.0);
        let p1_shifted = ((p1.x - shift.x) as f32, (p1.y - shift.y) as f32);
        let p2_shifted = ((p2.x - shift.x) as f32, (p2.y - shift.y) as f32);
        let diff_shifted = p2_shifted.0 - p1_shifted.0;

        println!("Direct f32 difference (should be ~0.001): {}", diff_direct);
        println!(
            "Shifted f32 difference (should be ~0.001): {}",
            diff_shifted
        );

        // The shifted version should be much closer to the true 1mm difference
        let error_direct = (diff_direct - offset as f32).abs();
        let error_shifted = (diff_shifted - offset as f32).abs();

        println!("Error without shift: {}m", error_direct);
        println!("Error with shift: {}m", error_shifted);

        // The shifted version should have significantly less error
        // (At least 100x better precision for typical Swiss coordinates)
        assert!(
            error_shifted < error_direct || error_shifted < 0.0001,
            "Shifted precision should be better than direct conversion"
        );
    }

    #[test]
    fn test_validate_indices_strips_out_of_bounds() {
        let mut mesh = Mesh {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0], // 3 vertices
            normals: vec![],
            indices: vec![
                0, 1, 2, // valid
                0, 1, 5, // invalid: vertex 5 out of bounds
                3, 4, 5, // invalid: all out of bounds
            ],
            rtc_applied: false,
            origin: [0.0; 3],
            instance_meta: None,
        };
        mesh.validate_indices();
        assert_eq!(mesh.indices, vec![0, 1, 2]);
    }

    #[test]
    fn test_validate_indices_empty_positions() {
        let mut mesh = Mesh {
            positions: vec![],
            normals: vec![],
            indices: vec![0, 1, 2],
            rtc_applied: false,
            origin: [0.0; 3],
            instance_meta: None,
        };
        mesh.validate_indices();
        assert!(mesh.indices.is_empty());
    }

    #[test]
    fn test_validate_indices_incomplete_triangle() {
        let mut mesh = Mesh {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            normals: vec![],
            indices: vec![0, 1, 2, 0, 1], // trailing incomplete triangle
            rtc_applied: false,
            origin: [0.0; 3],
            instance_meta: None,
        };
        mesh.validate_indices();
        assert_eq!(mesh.indices, vec![0, 1, 2]);
    }

    fn make_unwelded_box() -> Mesh {
        // A 1×1×1 cube emitted as triangle soup: each face has its own 4
        // vertices (not shared with adjacent faces), so 6 faces × 4 verts
        // = 24 vertices, 12 triangles. This is what the extrusion path
        // produces today.
        let mut m = Mesh::new();
        let corners = [
            (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0), (0.0, 1.0, 0.0),
            (0.0, 0.0, 1.0), (1.0, 0.0, 1.0), (1.0, 1.0, 1.0), (0.0, 1.0, 1.0),
        ];
        let faces: [([usize; 4], [f32; 3]); 6] = [
            ([0, 3, 2, 1], [0.0, 0.0, -1.0]), // bottom
            ([4, 5, 6, 7], [0.0, 0.0, 1.0]),  // top
            ([0, 1, 5, 4], [0.0, -1.0, 0.0]), // front
            ([2, 3, 7, 6], [0.0, 1.0, 0.0]),  // back
            ([0, 4, 7, 3], [-1.0, 0.0, 0.0]), // left
            ([1, 2, 6, 5], [1.0, 0.0, 0.0]),  // right
        ];
        for (idx, normal) in faces {
            let base = (m.positions.len() / 3) as u32;
            for &i in idx.iter() {
                let (x, y, z) = corners[i];
                m.positions.extend_from_slice(&[x, y, z]);
                m.normals.extend_from_slice(&normal);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
            m.indices.extend_from_slice(&[base, base + 2, base + 3]);
        }
        m
    }

    #[test]
    fn welded_preserves_corner_normals() {
        let m = make_unwelded_box();
        assert_eq!(m.vertex_count(), 24);
        assert_eq!(m.triangle_count(), 12);
        // With normal-preserving weld, each box corner has 3 incident
        // faces with 3 different normals, so each corner stays as 3
        // separate vertices. 6 faces × 4 vertices = 24 → 24 (no merge,
        // because no two of the 24 input vertices share BOTH position
        // and normal).
        let welded = m.welded(1e-6, 1e-3);
        assert_eq!(
            welded.vertex_count(),
            24,
            "normal-preserving weld must keep all per-face corner vertices"
        );
        assert_eq!(welded.triangle_count(), 12);
    }

    #[test]
    fn welded_by_position_collapses_corner_to_one_vertex() {
        let m = make_unwelded_box();
        // Position-only weld: all 24 input vertices map to the 8 box
        // corners. 8 vertices, 12 triangles (no degenerates since a
        // 1×1×1 box's corner-only mesh is non-degenerate).
        let welded = m.welded_by_position(1e-6);
        assert_eq!(
            welded.vertex_count(),
            8,
            "position-only weld must collapse 24 face-corner duplicates to 8 box corners"
        );
        assert_eq!(welded.triangle_count(), 12);
        // Averaged normal at each corner must be unit length (within f32
        // precision); we don't pin a specific direction because three
        // faces' normals sum to a face-diagonal direction.
        for chunk in welded.normals.chunks_exact(3) {
            let len_sq = chunk[0] * chunk[0] + chunk[1] * chunk[1] + chunk[2] * chunk[2];
            assert!(
                (len_sq - 1.0).abs() < 1e-4,
                "welded normal must be unit length, got |n|^2 = {}",
                len_sq
            );
        }
    }

    #[test]
    fn welded_drops_degenerate_triangles() {
        // A triangle whose three vertices all quantize to the same
        // position should be dropped after welding (it collapsed to a
        // point).
        let mut m = Mesh::new();
        m.positions = vec![
            0.0, 0.0, 0.0,
            // Two more "vertices" within position_eps of vertex 0:
            5e-8, 0.0, 0.0,
            0.0, 5e-8, 0.0,
            // A real non-degenerate triangle:
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0,
        ];
        m.normals = vec![
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
            0.0, 0.0, 1.0,
        ];
        m.indices = vec![
            0, 1, 2,   // collapses to a point after weld at eps=1e-6
            0, 3, 4,   // survives
        ];
        let welded = m.welded_by_position(1e-6);
        assert_eq!(welded.triangle_count(), 1);
    }

    #[test]
    fn welded_handles_empty_mesh() {
        let m = Mesh::new();
        let welded = m.welded(1e-6, 1e-3);
        assert!(welded.is_empty());
        let welded_pos = m.welded_by_position(1e-6);
        assert!(welded_pos.is_empty());
    }

    #[test]
    fn welded_strips_out_of_bound_indices() {
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        m.indices = vec![0, 1, 2, 0, 1, 99];
        let welded = m.welded_by_position(1e-6);
        assert_eq!(welded.triangle_count(), 1);
    }

    #[test]
    fn test_validate_indices_all_valid() {
        let mut mesh = Mesh {
            positions: vec![0.0; 12], // 4 vertices
            normals: vec![],
            indices: vec![0, 1, 2, 1, 2, 3],
            rtc_applied: false,
            origin: [0.0; 3],
            instance_meta: None,
        };
        mesh.validate_indices();
        assert_eq!(mesh.indices, vec![0, 1, 2, 1, 2, 3]);
    }

    // ── drop_thin_triangles / clean_degenerate ───────────────────────────

    const GRID: f64 = 1.0 / 65536.0; // ≈ 15.26 µm, the kernel reconcile grid

    #[test]
    fn drop_thin_removes_collinear_sliver_keeps_real_triangle() {
        // v0,v1,v2 are near-collinear: v2 sits 5 µm off the v0→v1 line over a
        // 1 m span — a zero-area sliver. A second, well-formed triangle
        // (v3,v4,v5, height 0.5 m) must survive.
        let mut mesh = Mesh {
            positions: vec![
                0.0, 0.0, 0.0, // v0
                1.0, 0.0, 0.0, // v1
                0.5, 5.0e-6, 0.0, // v2  (5 µm off the line → sliver)
                0.0, 0.0, 0.0, // v3
                1.0, 0.0, 0.0, // v4
                0.5, 0.5, 0.0, // v5  (real, 0.5 m tall)
            ],
            normals: vec![],
            indices: vec![0, 1, 2, 3, 4, 5],
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, };
        mesh.drop_thin_triangles(GRID);
        assert_eq!(mesh.indices, vec![3, 4, 5], "sliver dropped, real kept");
        // Positions/normals are never touched (orphan vertices are fine).
        assert_eq!(mesh.positions.len(), 18);
    }

    #[test]
    fn drop_thin_removes_coincident_pair_needle() {
        // Two vertices identical → zero area regardless of the third.
        let mut mesh = Mesh {
            positions: vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            normals: vec![],
            indices: vec![0, 1, 2],
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, };
        mesh.drop_thin_triangles(GRID);
        assert!(mesh.indices.is_empty(), "coincident-pair needle dropped");
    }

    #[test]
    fn drop_thin_keeps_thin_but_real_triangle_just_above_grid() {
        // Height 30 µm (> 15.26 µm grid) over a 1 m base — thin but real.
        let mut mesh = Mesh {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 30.0e-6, 0.0],
            normals: vec![],
            indices: vec![0, 1, 2],
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, };
        mesh.drop_thin_triangles(GRID);
        assert_eq!(mesh.indices, vec![0, 1, 2], "above-grid triangle kept");
    }

    #[test]
    fn drop_thin_does_not_open_a_crack_in_a_closed_solid() {
        // A closed tetrahedron with ONE extra degenerate sliver triangle glued
        // along an existing edge. Dropping the sliver must leave exactly the 4
        // real faces — i.e. it removes the sliver and nothing else, so the
        // watertight surface is unchanged (no real face is collateral-dropped).
        let a = [0.0f32, 0.0, 0.0];
        let b = [1.0f32, 0.0, 0.0];
        let c = [0.0f32, 1.0, 0.0];
        let d = [0.0f32, 0.0, 1.0];
        let mut pos = vec![];
        for v in [a, b, c, d] {
            pos.extend_from_slice(&v);
        }
        // sliver vertex on edge a→b, 5 µm off-line
        pos.extend_from_slice(&[0.5, 5.0e-6, 0.0]); // index 4
        let mut mesh = Mesh {
            positions: pos,
            normals: vec![],
            indices: vec![
                0, 1, 2, // 4 tetra faces
                0, 1, 3, 0, 2, 3, 1, 2, 3, // (winding irrelevant for this test)
                0, 1, 4, // the degenerate sliver along edge 0→1
            ],
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, };
        mesh.drop_thin_triangles(GRID);
        assert_eq!(
            mesh.indices,
            vec![0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
            "only the sliver dropped; the 4 closed faces are intact"
        );
    }

    #[test]
    fn drop_thin_skips_oob_and_fully_collapsed_without_panic() {
        let mut mesh = Mesh {
            positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            normals: vec![],
            indices: vec![
                0, 1, 2, // valid, real
                0, 1, 9, // out-of-bounds index → skipped
                0, 0, 0, // fully collapsed (longest == 0) → skipped
            ],
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, };
        mesh.drop_thin_triangles(GRID);
        assert_eq!(mesh.indices, vec![0, 1, 2]);
    }

    #[test]
    fn drop_thin_is_idempotent() {
        let mut mesh = Mesh {
            positions: vec![
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 5.0e-6, 0.0, // sliver
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 0.5, 0.0, // real
            ],
            normals: vec![],
            indices: vec![0, 1, 2, 3, 4, 5],
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, };
        mesh.drop_thin_triangles(GRID);
        let once = mesh.indices.clone();
        mesh.drop_thin_triangles(GRID);
        assert_eq!(mesh.indices, once, "second pass is a no-op");
    }

    #[test]
    fn clean_degenerate_uses_the_reconcile_grid() {
        // clean_degenerate must drop a 10 µm sliver (below grid) and keep a
        // 30 µm one (above grid).
        let mut mesh = Mesh {
            positions: vec![
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 10.0e-6, 0.0, // below grid
                0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 30.0e-6, 0.0, // above grid
            ],
            normals: vec![],
            indices: vec![0, 1, 2, 3, 4, 5],
            rtc_applied: false,
            origin: [0.0; 3],
        instance_meta: None, };
        mesh.clean_degenerate();
        assert_eq!(mesh.indices, vec![3, 4, 5]);
    }
}
