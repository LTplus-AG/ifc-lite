// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh data structures

use nalgebra::{Point3, Vector3};

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
    /// Local (pre-placement, object-space) AABB — `positions` bounds as they
    /// were BEFORE `apply_placement`'s transform was baked in. `None` for an
    /// empty mesh or one that never went through `transform_mesh_world_framed`
    /// (e.g. synthetic/test meshes). Unrelated to `origin`, which is a
    /// *world*-space translation captured AFTER the transform, purely for f32
    /// precision — see issue #1474.
    pub local_bounds: Option<[f32; 6]>, // minX,minY,minZ,maxX,maxY,maxZ
    /// The resolved `IfcLocalPlacement` chain applied to this mesh by
    /// `apply_placement` (row-major, same convention as
    /// [`InstanceMeta::transform`]). `None` when no placement was applied
    /// (synthetic/test meshes) — see issue #1474.
    pub local_to_world: Option<[f64; 16]>,
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
    /// Per-vertex texture coordinates (u, v pairs, 1:1 with `mesh.positions`),
    /// present only for textured face sets (#1781). Downstream index-only edits
    /// (winding orientation, degenerate-triangle drops) and rigid transforms
    /// keep them aligned; anything that rebuilds vertices must drop them.
    pub uvs: Option<Vec<f32>>,
    /// The surface texture sampled by `uvs` (#1781).
    pub texture: Option<crate::processors::texture::TextureAttachment>,
}

impl SubMesh {
    /// Create a new sub-mesh
    pub fn new(geometry_id: u32, mesh: Mesh) -> Self {
        Self {
            geometry_id,
            mesh,
            uvs: None,
            texture: None,
        }
    }

    /// Create a textured sub-mesh (#1781): `uvs` are 1:1 with `mesh.positions`.
    pub fn textured(
        geometry_id: u32,
        mesh: Mesh,
        uvs: Vec<f32>,
        texture: crate::processors::texture::TextureAttachment,
    ) -> Self {
        Self {
            geometry_id,
            mesh,
            uvs: Some(uvs),
            texture: Some(texture),
        }
    }
}

/// Collection of sub-meshes from an element, preserving per-item identity
#[derive(Debug, Clone, Default)]
pub struct SubMeshCollection {
    pub sub_meshes: Vec<SubMesh>,
    /// What `SubMesh::geometry_id` MEANS here: `false` (default) an
    /// `IfcRepresentationItem`, `true` an `IfcMaterial` (only `layers.rs` builds
    /// those). Uniform across the collection, which is why it lives on it.
    ///
    /// Deliberately NOT `geometry_class == GEOM_CLASS_LAYER_SLICE`, which cannot
    /// answer it: that class is stamped from `is_material_layer_sliceable`, a
    /// static check made BEFORE the geometry runs, while
    /// `try_layered_sub_meshes` can still return `None` and fall through to the
    /// rep-item path — so rep-item ids can carry class 3 (#3199).
    /// SCOPE: it decides only which FIELD `emit_sub_meshes` emits the id under —
    /// five style lookups in `element.rs` still read `geometry_id` as a rep item
    /// on BOTH paths, safe only by express-id uniqueness (#3211).
    pub ids_are_materials: bool,
}

impl SubMeshCollection {
    /// Create a new empty collection
    pub fn new() -> Self {
        Self::default()
    }

    /// `geometry_id`s are `IfcMaterial` ids. Only `layers.rs` builds these.
    pub fn of_materials() -> Self {
        Self {
            ids_are_materials: true,
            ..Self::default()
        }
    }

    /// Add a sub-mesh
    pub fn add(&mut self, geometry_id: u32, mesh: Mesh) {
        if !mesh.is_empty() {
            self.sub_meshes.push(SubMesh::new(geometry_id, mesh));
        }
    }

    /// Add a textured sub-mesh (#1781).
    pub fn add_textured(
        &mut self,
        geometry_id: u32,
        mesh: Mesh,
        uvs: Vec<f32>,
        texture: crate::processors::texture::TextureAttachment,
    ) {
        if !mesh.is_empty() {
            self.sub_meshes
                .push(SubMesh::textured(geometry_id, mesh, uvs, texture));
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
            local_bounds: None,
            local_to_world: None,
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
            local_bounds: None,
            local_to_world: None,
        }
    }

    /// Build a mesh with FRESH geometry buffers (`positions` / `normals` /
    /// `indices`) that carries THIS mesh's placement/frame metadata forward:
    /// `origin` (RTC / local-frame translation), `rtc_applied`, `local_bounds`
    /// and `local_to_world` (the #1474 placement capture).
    ///
    /// This is the correct constructor for an in-place rebuild pass that
    /// REPLACES the vertex buffers of an already-placed mesh (sliver refine,
    /// subdivide, weld). Constructing a bare `Mesh` and copying back only a
    /// field or two silently resets `origin` and the #1474 capture to their
    /// defaults, which mis-places the rebuilt host at the world origin on
    /// local-framed (large / georeferenced) models — see facet_weld's
    /// sliver-refine and this module's `subdivide_once` / `weld_impl`.
    ///
    /// `instance_meta` is intentionally NOT carried. Every such rebuild CHANGES
    /// the vertices, so the mesh no longer reproduces its representation's
    /// canonical geometry; carrying the (vertex-invariant) `rep_identity`
    /// forward would let the GPU-instancing collator dedup this changed mesh
    /// against an *unrefined* sibling that shares the same `rep_identity` and
    /// draw the wrong geometry. Dropping it mirrors the void-cut path, which
    /// nulls `instance_meta` for exactly this reason.
    ///
    /// # Precondition
    ///
    /// The new buffers MUST NOT extend the mesh's spatial extent beyond the
    /// original: the carried `local_bounds` stays valid only because it remains
    /// a *superset* of the rebuilt vertices' extent. This holds for every
    /// current caller — sliver-refine and subdivide insert edge/interior
    /// midpoints (convex combinations that lie inside the existing hull), and
    /// weld only merges/moves coincident vertices to a snapped position (a
    /// subset extent). A future caller that GROWS the extent (adds vertices
    /// outside the original hull) must NOT use this constructor for
    /// `local_bounds`: it has to recompute `local_bounds` from the new positions
    /// or pass through a variant that sets it to `None`.
    pub fn rebuilt_like(&self, positions: Vec<f32>, normals: Vec<f32>, indices: Vec<u32>) -> Mesh {
        Mesh {
            positions,
            normals,
            indices,
            rtc_applied: self.rtc_applied,
            origin: self.origin,
            instance_meta: None,
            local_bounds: self.local_bounds,
            local_to_world: self.local_to_world,
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
        // Adding midpoints changes the vertex buffers, so carry the placement /
        // frame metadata (origin, rtc, #1474 capture) but drop instance_meta
        // (this mesh no longer matches its canonical rep) via `rebuilt_like`.
        self.rebuilt_like(positions, normals, indices)
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
            // Drop any out-of-range triangle BEFORE the unchecked `bits()` closure
            // indexes positions[] (unlike `vert()` below, `bits()` has no bounds
            // check). Matches the drop-not-panic contract of vert()/validate_indices;
            // sibling drop_thin_triangles guards the same way.
            if ia as usize >= vertex_count
                || ib as usize >= vertex_count
                || ic as usize >= vertex_count
            {
                continue;
            }
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
        // Same concern for the local-bounds/placement capture (issue #1474).
        self.local_bounds = None;
        self.local_to_world = None;
    }

    /// Weld vertices that share a position, regardless of normal.
    ///
    /// Returns a new mesh where vertices at the same position (within
    /// `position_eps`) collapse to one canonical vertex; the welded
    /// vertex's normal is the sum of contributing normals, re-normalized
    /// (or a neutral up-Z `(0, 0, 1)` default if the sum is degenerate,
    /// e.g. exactly opposing normals cancelling out).
    /// Triangles that collapse to a degenerate edge or point are dropped.
    ///
    /// **Use this when you need a topologically connected, manifold-
    /// candidate mesh** — volume queries, CSG operands, watertight
    /// checks, mesh repair pipelines. Shading at sharp corners gets
    /// averaged.
    ///
    /// `position_eps` is the bucket size in metres (1 µm is a safe
    /// default for IFC).
    pub fn welded_by_position(&self, position_eps: f32) -> Mesh {
        weld_impl(self, position_eps, /*average_normals=*/ true)
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
        // The kernel's canonical reconcile grid (power-of-two for
        // bit-determinism). Sub-grid triangles are below kernel resolution.
        self.drop_thin_triangles(crate::kernel::mesh_bridge::SNAP_GRID);
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

    /// Clip a void-cut result to the host's pre-cut AABB `[min, max]`, dropping
    /// any triangle poking beyond it (see [`Mesh::clip_triangles_to_aabb`]). A
    /// subtract can only remove material, so anything past the host AABB is a cut
    /// artifact. The tolerance absorbs f64→f32 round-trip jitter (sub-mm), so it
    /// is a small ABSOLUTE band, NOT a fraction of host size: an unbounded
    /// `1e-3 * diag` reaches 0.13 m on a 130 m floor slab — wider than the
    /// ~0.105 m flush-cap reveal overhang it must trap, which is why only large
    /// slabs/roofs leaked it (a 5 m wall's 5 mm pad already trims the identical
    /// overhang, #1633). Clamped to [5 mm, 10 mm]: byte-identical to the former
    /// `1e-3 * diag` for hosts ≤ 10 m diagonal (`1e-3 * diag ≤ 1e-2`), trimming
    /// on every larger one. Returns the count dropped.
    pub fn clip_triangles_to_host_aabb(&mut self, min: [f32; 3], max: [f32; 3]) -> usize {
        // Widen to f64 BEFORE subtracting (not `(max - min) as f64`) so `diag`,
        // and thus `pad`, is bit-for-bit what the former inline `wall_max.x -
        // wall_min.x` (f64) computed — the clamp is the only intended change.
        let diag = ((max[0] as f64 - min[0] as f64).powi(2)
            + (max[1] as f64 - min[1] as f64).powi(2)
            + (max[2] as f64 - min[2] as f64).powi(2))
        .sqrt();
        let pad = (1.0e-3 * diag).clamp(5.0e-3, 1.0e-2) as f32;
        self.clip_triangles_to_aabb(min, max, pad)
    }
}

impl Default for Mesh {
    fn default() -> Self {
        Self::new()
    }
}

/// Shared welding implementation backing `Mesh::welded_by_position`.
///
/// The dedupe key is `quantized_position` only. `average_normals=true`
/// accumulates contributing normals into the welded vertex and
/// renormalizes at the end.
fn weld_impl(mesh: &Mesh, position_eps: f32, average_normals: bool) -> Mesh {
    use rustc_hash::FxHashMap;

    let n_verts = mesh.positions.len() / 3;
    if n_verts == 0 {
        return Mesh::new();
    }

    let has_normals = mesh.normals.len() == mesh.positions.len();
    let pos_scale = 1.0 / position_eps.max(f32::MIN_POSITIVE);
    let q_pos = |v: f32| -> i64 { (v * pos_scale).round() as i64 };

    // Dedupe key: quantized position only.
    type Key = [i64; 3];
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
        let key: Key = [q_pos(px), q_pos(py), q_pos(pz)];

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

    // Welding collapses / moves vertices, so carry the placement / frame
    // metadata (origin, rtc, #1474 capture) but drop instance_meta (the welded
    // mesh no longer matches its canonical rep) via `rebuilt_like`.
    mesh.rebuilt_like(new_positions, new_normals, new_indices)
}

#[cfg(test)]
#[path = "mesh_tests.rs"]
mod tests;
