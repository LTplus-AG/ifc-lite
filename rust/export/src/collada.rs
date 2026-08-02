// SPDX-License-Identifier: MPL-2.0
//! **COLLADA 1.4.1** (`.dae`) exporter — the model format Google Earth's KML
//! `<Model>` actually loads (it does NOT accept glTF/GLB; a `.glb` in `<Model>`
//! fails with "Unsupported element: Model"). Used to build the KMZ payload (#1427).
//!
//! Input is the viewer's already-produced **Y-up** `MeshData` (the from-meshes
//! path), identical to the GLB exporter. Two Google-Earth-specific choices make
//! the model render correctly:
//!
//! - **Orientation:** vertices are converted back to the IFC-native **Z-up** frame
//!   (`(x, y, z)_yup -> (x, -z, y)_zup`) and the document declares `<up_axis>Z_UP</up_axis>`,
//!   so the building stands upright. Horizontal grid-north alignment is carried by
//!   the KML `<Model><Orientation><heading>` (computed elsewhere), exactly as the
//!   GLB path did, so X/Y placement matches the (already-correct) GLB output.
//! - **Brightness:** Google Earth has no ambient/IBL and a single hard sun, so a
//!   plain diffuse material renders near-black. Each material sets `<emission>` to
//!   its colour (the well-known "make Google Earth models glow" trick) so the model
//!   shows its true colour. Faces are flagged `double_sided` via the `GOOGLEEARTH`
//!   profile extra (IFC winding isn't reliably outward).

use std::collections::HashMap;
use std::fmt::Write as _;

/// Material dedup key: RGBA rounded to 2 decimals (matches the glTF exporter).
fn color_key(c: [f32; 4]) -> (i32, i32, i32, i32) {
    let r = |v: f32| (v * 100.0).round() as i32;
    (r(c[0]), r(c[1]), r(c[2]), r(c[3]))
}

/// Convert a Y-up vector back to the IFC-native Z-up frame: `(x, y, z) -> (x, -z, y)`.
#[inline]
fn to_zup(x: f64, y: f64, z: f64) -> [f64; 3] {
    [x, -z, y]
}

/// Vertex dedup key: position quantised to 0.1 mm + normal to ~1e-3 (the emitted
/// precision), so vertices that serialise identically collapse to one. Quantises in
/// f64→i64 so large world coordinates (e.g. a national-grid model not RTC-shifted,
/// hundreds of km) can't overflow the key and merge unrelated vertices. The position
/// is kept in f64 end-to-end (only normals, which are unit-scale, are f32) so a
/// large-georef world coordinate is not quantised by an early f32 downcast.
#[inline]
fn vert_key(p: [f64; 3], n: [f32; 3]) -> [i64; 6] {
    let qp = |v: f64| (v * 10_000.0).round() as i64;
    let qn = |v: f32| (v as f64 * 1_000.0).round() as i64;
    [qp(p[0]), qp(p[1]), qp(p[2]), qn(n[0]), qn(n[1]), qn(n[2])]
}

/// Build a Google-Earth-compatible COLLADA 1.4.1 `.dae` from already-produced
/// (Y-up) meshes, flattened into parallel arrays exactly like
/// `export_glb_from_meshes`. Per mesh `i`: `vertex_counts[i]` vertices +
/// `index_counts[i]` indices taken in order from the concatenated
/// `positions`/`normals`/`indices`; `colors` is RGBA per mesh, `origins` xyz per
/// mesh (`world = origin + position`). Returns the `.dae` bytes (UTF-8 XML).
#[allow(clippy::too_many_arguments)]
#[allow(clippy::needless_range_loop)]
pub fn export_collada_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
) -> Vec<u8> {
    // Concatenated Z-up vertex buffers (one shared POSITION + NORMAL source) and,
    // per material, the triangle indices into that shared buffer. Positions are
    // accumulated in f64 so `world = origin + position` and the subsequent AABB
    // re-centering keep full precision at georef scale; the buffer is downcast to
    // f32 only once, after centering, just before serialisation.
    let mut pos: Vec<f64> = Vec::new();
    let mut nrm: Vec<f32> = Vec::new();
    let mut mat_colors: Vec<[f32; 4]> = Vec::new();
    let mut mat_tris: Vec<Vec<u32>> = Vec::new();
    let mut mat_map: HashMap<(i32, i32, i32, i32), usize> = HashMap::new();
    // Global vertex dedup: quantised (position, normal) → index into pos/nrm. Merges
    // identical vertices within and across meshes so a non-indexed IFC mesh (per-face
    // vertices) doesn't blow past Google Earth's render limits.
    let mut dedup: HashMap<[i64; 6], u32> = HashMap::new();

    let n = vertex_counts.len();
    let mut vbase = 0usize; // running vertex offset into the flat input
    let mut ibase = 0usize; // running index offset into the flat input
    for i in 0..n {
        let vc = vertex_counts[i] as usize;
        let ic = index_counts.get(i).copied().unwrap_or(0) as usize;
        if (vbase + vc) * 3 > positions.len() || ibase + ic > indices.len() {
            break; // malformed counts — stop rather than panic
        }
        let pslice = &positions[vbase * 3..(vbase + vc) * 3];
        let nslice: &[f32] = if normals.len() >= (vbase + vc) * 3 {
            &normals[vbase * 3..(vbase + vc) * 3]
        } else {
            &[]
        };
        let islice = &indices[ibase..ibase + ic];
        let color = [
            colors.get(i * 4).copied().unwrap_or(0.8),
            colors.get(i * 4 + 1).copied().unwrap_or(0.8),
            colors.get(i * 4 + 2).copied().unwrap_or(0.8),
            colors.get(i * 4 + 3).copied().unwrap_or(1.0),
        ];
        let origin = [
            origins.get(i * 3).copied().unwrap_or(0.0),
            origins.get(i * 3 + 1).copied().unwrap_or(0.0),
            origins.get(i * 3 + 2).copied().unwrap_or(0.0),
        ];

        // Skip degenerate meshes (mirrors the glTF `view_ok` guard).
        if islice.is_empty() || pslice.len() < 9 || !pslice.len().is_multiple_of(3) {
            vbase += vc;
            ibase += ic;
            continue;
        }

        // Bake world = origin + position into Z-up, deduplicating by (position,
        // normal). The world position is accumulated in f64 so a large-georef
        // coordinate is not quantised by an f32 downcast before centering. `l2g`
        // maps this mesh's local vertex index → the shared deduped index. A hard
        // edge keeps distinct normals, so its vertices are NOT merged → flat shading
        // is preserved; only redundant same-position-same-normal vertices collapse.
        let has_normals = nslice.len() == pslice.len();
        let mut l2g = vec![0u32; vc];
        for vi in 0..vc {
            let p = &pslice[vi * 3..vi * 3 + 3];
            let zp = to_zup(
                p[0] as f64 + origin[0],
                p[1] as f64 + origin[1],
                p[2] as f64 + origin[2],
            );
            // Normals are unit-scale direction vectors; f32 carries them losslessly.
            let zn = if has_normals {
                let nv = &nslice[vi * 3..vi * 3 + 3];
                let z = to_zup(nv[0] as f64, nv[1] as f64, nv[2] as f64);
                [z[0] as f32, z[1] as f32, z[2] as f32]
            } else {
                [0.0, 0.0, 1.0]
            };
            l2g[vi] = *dedup.entry(vert_key(zp, zn)).or_insert_with(|| {
                let g = (pos.len() / 3) as u32;
                pos.extend_from_slice(&zp);
                nrm.extend_from_slice(&zn);
                g
            });
        }

        let mi = *mat_map.entry(color_key(color)).or_insert_with(|| {
            mat_colors.push(color);
            mat_tris.push(Vec::new());
            mat_colors.len() - 1
        });
        // Keep only whole triangles (a trailing partial triangle would desync
        // `<triangles count>` from `<p>`); drop indices outside this mesh's vertex
        // range; remap each to its deduped global index, dropping any triangle that
        // dedup collapsed to zero area (two corners merged).
        let tri_len = islice.len() - islice.len() % 3;
        for tri in islice[..tri_len].chunks_exact(3) {
            if tri.iter().all(|&idx| (idx as usize) < vc) {
                let (a, b, c) = (l2g[tri[0] as usize], l2g[tri[1] as usize], l2g[tri[2] as usize]);
                if a != b && b != c && a != c {
                    mat_tris[mi].extend_from_slice(&[a, b, c]);
                }
            }
        }

        vbase += vc;
        ibase += ic;
    }

    // Center the model on its horizontal (X,Y) AABB centre so the .dae origin
    // coincides with the geometry centre. The KMZ <Model> pins the .dae origin to
    // <Location>, and that lat/lon is computed for the geometry's AABB centre (the
    // viewer's reproject adds the model centre to the MapConversion eastings/northings).
    // Without this the model lands offset by however far its geometry sits from the
    // local/survey origin — e.g. a CH1903+/LV95 model whose structure is 200 m from
    // the project origin appeared ~250 m away in Google Earth (#1427). Z is left alone
    // so clampToGround rests project-zero on the terrain (foundations below, frame above).
    if pos.len() >= 3 {
        let mut min_x = f64::INFINITY;
        let mut max_x = f64::NEG_INFINITY;
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for v in pos.chunks_exact(3) {
            min_x = min_x.min(v[0]);
            max_x = max_x.max(v[0]);
            min_y = min_y.min(v[1]);
            max_y = max_y.max(v[1]);
        }
        let cx = (min_x + max_x) * 0.5;
        let cy = (min_y + max_y) * 0.5;
        for v in pos.chunks_exact_mut(3) {
            v[0] -= cx;
            v[1] -= cy;
        }
    }

    // Downcast the centered (small, origin-local) coordinates to f32 only now — the
    // accumulation + AABB centering above ran in f64 to survive georef magnitudes.
    let pos_f32: Vec<f32> = pos.iter().map(|&c| c as f32).collect();
    write_dae(&pos_f32, &nrm, &mat_colors, &mat_tris)
}

/// Serialise the collected geometry + materials into a COLLADA 1.4.1 document.
///
/// The geometry is split into multiple `<geometry>` chunks so that no single
/// `<float_array>` becomes a huge XML text node. Strict XML parsers (libxml2 and,
/// in practice, Google Earth) reject a text node larger than ~10 MB, so a big model
/// emitted as one array fails to parse and renders nothing — the "model loads but is
/// invisible" failure on large models (#1427). Each chunk is self-contained (its own
/// POSITION/NORMAL sources, re-indexed chunk-local) so no triangle spans a chunk.
fn write_dae(
    pos: &[f32],
    nrm: &[f32],
    mat_colors: &[[f32; 4]],
    mat_tris: &[Vec<u32>],
) -> Vec<u8> {
    // Two independent caps per chunk, both of which Google Earth enforces and which a
    // strict XML parser also implies:
    //  - MAX_VERTS: keeps a geometry under Google Earth's ~64K-vertex-per-model limit
    //    AND keeps each <float_array> a small XML text node (strict parsers reject a
    //    text node over ~10 MB, so one giant array makes the model load-but-invisible).
    //  - MAX_TRIS: keeps each <triangles> under Google Earth's 16-bit index ceiling of
    //    21,845 triangles (65535/3); above it the mesh silently fails to draw.
    const MAX_VERTS: usize = 60_000;
    const MAX_TRIS: usize = 20_000;

    struct Chunk {
        pos: Vec<f32>,
        nrm: Vec<f32>,
        tris: Vec<Vec<u32>>, // per material → chunk-local triangle indices
    }

    let mut chunks: Vec<Chunk> = Vec::new();
    let mut cur = Chunk { pos: Vec::new(), nrm: Vec::new(), tris: vec![Vec::new(); mat_colors.len()] };
    let mut cur_tris = 0usize;
    let mut remap: HashMap<u32, u32> = HashMap::new();
    for (m, tris) in mat_tris.iter().enumerate() {
        for tri in tris.chunks_exact(3) {
            let fresh = tri.iter().filter(|&&g| !remap.contains_key(&g)).count();
            if !cur.pos.is_empty()
                && (cur.pos.len() / 3 + fresh > MAX_VERTS || cur_tris >= MAX_TRIS)
            {
                chunks.push(std::mem::replace(
                    &mut cur,
                    Chunk { pos: Vec::new(), nrm: Vec::new(), tris: vec![Vec::new(); mat_colors.len()] },
                ));
                cur_tris = 0;
                remap.clear();
            }
            let mut local = [0u32; 3];
            for (k, &g) in tri.iter().enumerate() {
                local[k] = match remap.get(&g) {
                    Some(&l) => l,
                    None => {
                        let l = (cur.pos.len() / 3) as u32;
                        let gi = g as usize * 3;
                        cur.pos.extend_from_slice(&pos[gi..gi + 3]);
                        cur.nrm.extend_from_slice(&nrm[gi..gi + 3]);
                        remap.insert(g, l);
                        l
                    }
                };
            }
            cur.tris[m].extend_from_slice(&local);
            cur_tris += 1;
        }
    }
    if !cur.pos.is_empty() {
        chunks.push(cur);
    }

    let mut s = String::with_capacity(pos.len() * 7 + nrm.len() * 7 + 4096);

    // `<created>`/`<modified>` are REQUIRED by the COLLADA 1.4.1 schema; a fixed
    // epoch keeps the document deterministic and wasm-safe (no wall clock).
    s.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor><authoring_tool>IFC-Lite</authoring_tool></contributor>
    <created>1970-01-01T00:00:00Z</created>
    <modified>1970-01-01T00:00:00Z</modified>
    <unit name="meter" meter="1"/>
    <up_axis>Z_UP</up_axis>
  </asset>
"#);

    // ── Effects: emission = colour (Google Earth glow) + double_sided ───────────
    s.push_str("  <library_effects>\n");
    for (k, c) in mat_colors.iter().enumerate() {
        // emission = colour is the brightness lever (no ambient/IBL in Google Earth);
        // ambient is zeroed so the engine's ambient term can't darken the surface.
        let _ = write!(
            s,
            r#"    <effect id="eff{k}">
      <profile_COMMON>
        <technique sid="common">
          <lambert>
            <emission><color>{r} {g} {b} 1</color></emission>
            <ambient><color>0 0 0 1</color></ambient>
            <diffuse><color>{r} {g} {b} 1</color></diffuse>
"#,
            k = k,
            r = c[0],
            g = c[1],
            b = c[2],
        );
        if c[3] < 1.0 {
            // A_ONE: final opacity is the transparent colour's alpha (transparency
            // kept at 1). Carry the material colour + its alpha so Google Earth
            // renders the surface translucent at the authored colour.
            let _ = write!(
                s,
                "            <transparent opaque=\"A_ONE\"><color>{r} {g} {b} {a}</color></transparent>\n            <transparency><float>1</float></transparency>\n",
                r = c[0],
                g = c[1],
                b = c[2],
                a = c[3],
            );
        }
        // GOOGLEEARTH double_sided is an <extra> on <profile_COMMON> (a sibling of
        // <technique sid="common">, NOT inside it) — the schema-validated placement
        // Google Earth reads. IFC winding isn't reliably outward, so render both sides.
        s.push_str(
            r#"          </lambert>
        </technique>
        <extra><technique profile="GOOGLEEARTH"><double_sided>1</double_sided></technique></extra>
      </profile_COMMON>
    </effect>
"#,
        );
    }
    s.push_str("  </library_effects>\n");

    // ── Materials ───────────────────────────────────────────────────────────────
    s.push_str("  <library_materials>\n");
    for k in 0..mat_colors.len() {
        let _ = writeln!(
            s,
            "    <material id=\"mat{k}\" name=\"mat{k}\"><instance_effect url=\"#eff{k}\"/></material>",
            k = k
        );
    }
    s.push_str("  </library_materials>\n");

    // ── Geometry: one <geometry> per chunk, each with bounded float_arrays ──────
    s.push_str("  <library_geometries>\n");
    for (ci, ch) in chunks.iter().enumerate() {
        let vc = ch.pos.len() / 3;
        let _ = write!(s, "    <geometry id=\"geo{ci}\" name=\"geo{ci}\">\n      <mesh>\n");
        // POSITION source.
        let _ = write!(s, "        <source id=\"geo{ci}-pos\">\n          <float_array id=\"geo{ci}-pos-arr\" count=\"{}\">", ch.pos.len());
        append_floats(&mut s, &ch.pos);
        let _ = write!(s, "</float_array>\n          <technique_common>\n            <accessor source=\"#geo{ci}-pos-arr\" count=\"{vc}\" stride=\"3\">\n              <param name=\"X\" type=\"float\"/><param name=\"Y\" type=\"float\"/><param name=\"Z\" type=\"float\"/>\n            </accessor>\n          </technique_common>\n        </source>\n");
        // NORMAL source.
        let _ = write!(s, "        <source id=\"geo{ci}-nrm\">\n          <float_array id=\"geo{ci}-nrm-arr\" count=\"{}\">", ch.nrm.len());
        append_floats(&mut s, &ch.nrm);
        let _ = write!(s, "</float_array>\n          <technique_common>\n            <accessor source=\"#geo{ci}-nrm-arr\" count=\"{}\" stride=\"3\">\n              <param name=\"X\" type=\"float\"/><param name=\"Y\" type=\"float\"/><param name=\"Z\" type=\"float\"/>\n            </accessor>\n          </technique_common>\n        </source>\n", ch.nrm.len() / 3);
        // Shared vertices referencing POSITION.
        let _ = write!(s, "        <vertices id=\"geo{ci}-vtx\">\n          <input semantic=\"POSITION\" source=\"#geo{ci}-pos\"/>\n        </vertices>\n");
        // One <triangles> per material present in this chunk; <p> interleaves VERTEX +
        // NORMAL indices (equal — normals are per-vertex).
        for (k, t) in ch.tris.iter().enumerate() {
            if t.is_empty() {
                continue;
            }
            let _ = write!(s, "        <triangles material=\"sym{k}\" count=\"{}\">\n          <input semantic=\"VERTEX\" source=\"#geo{ci}-vtx\" offset=\"0\"/>\n          <input semantic=\"NORMAL\" source=\"#geo{ci}-nrm\" offset=\"1\"/>\n          <p>", t.len() / 3);
            for (j, &idx) in t.iter().enumerate() {
                if j > 0 {
                    s.push(' ');
                }
                let _ = write!(s, "{idx} {idx}");
            }
            s.push_str("</p>\n        </triangles>\n");
        }
        s.push_str("      </mesh>\n    </geometry>\n");
    }
    s.push_str("  </library_geometries>\n");

    // ── Visual scene: one node per chunk, each binding the materials it uses ────
    s.push_str("  <library_visual_scenes>\n    <visual_scene id=\"scene\">\n");
    for (ci, ch) in chunks.iter().enumerate() {
        let _ = write!(s, "      <node id=\"n{ci}\" name=\"n{ci}\">\n        <instance_geometry url=\"#geo{ci}\">\n          <bind_material>\n            <technique_common>\n");
        for (k, t) in ch.tris.iter().enumerate() {
            if t.is_empty() {
                continue;
            }
            let _ = writeln!(s, "              <instance_material symbol=\"sym{k}\" target=\"#mat{k}\"/>");
        }
        s.push_str("            </technique_common>\n          </bind_material>\n        </instance_geometry>\n      </node>\n");
    }
    s.push_str("    </visual_scene>\n  </library_visual_scenes>\n");

    s.push_str("  <scene><instance_visual_scene url=\"#scene\"/></scene>\n</COLLADA>\n");

    s.into_bytes()
}

/// Append space-separated floats, trimming trailing zeros for compactness while
/// keeping enough precision for metre-scale building coordinates.
fn append_floats(s: &mut String, vals: &[f32]) {
    for (i, v) in vals.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        let _ = write!(s, "{}", fmt_f32(*v));
    }
}

/// Format an f32 with up to 4 decimals (0.1 mm at building scale), no trailing
/// zeros — keeps the document compact (fewer chars per coordinate) while staying
/// far below any visible tolerance.
fn fmt_f32(v: f32) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    let mut t = format!("{v:.4}");
    if t.contains('.') {
        while t.ends_with('0') {
            t.pop();
        }
        if t.ends_with('.') {
            t.pop();
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(positions, normals, indices, vertex_counts, index_counts, colors, origins)`.
    type MeshArrays = (Vec<f32>, Vec<f32>, Vec<u32>, Vec<u32>, Vec<u32>, Vec<f32>, Vec<f64>);

    fn one_quad() -> MeshArrays {
        // A unit quad in the XY plane (Y-up input), single red mesh.
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
        let indices = vec![0u32, 1, 2, 0, 2, 3];
        (positions, normals, indices, vec![4], vec![6], vec![1.0, 0.0, 0.0, 1.0], vec![0.0, 0.0, 0.0])
    }

    #[test]
    fn emits_valid_collada_skeleton() {
        let (p, n, i, vc, ic, col, og) = one_quad();
        let dae = export_collada_from_meshes(&p, &n, &i, &vc, &ic, &col, &og);
        let xml = String::from_utf8(dae).unwrap();
        assert!(xml.contains(r#"version="1.4.1""#));
        assert!(xml.contains("<up_axis>Z_UP</up_axis>"));
        assert!(xml.contains("<unit name=\"meter\" meter=\"1\"/>"));
        assert!(xml.contains("<instance_visual_scene url=\"#scene\"/>"));
        // The shared geometry + a triangles block bound to the material.
        assert!(xml.contains("<triangles material=\"sym0\""));
        assert!(xml.contains("<instance_material symbol=\"sym0\" target=\"#mat0\"/>"));
    }

    #[test]
    fn emission_carries_colour_and_double_sided() {
        let (p, n, i, vc, ic, col, og) = one_quad();
        let xml = String::from_utf8(export_collada_from_meshes(&p, &n, &i, &vc, &ic, &col, &og)).unwrap();
        // Red emission = brightness lever for Google Earth.
        assert!(xml.contains("<emission><color>1 0 0 1</color></emission>"));
        assert!(xml.contains("<double_sided>1</double_sided>"));
        assert!(xml.contains("profile=\"GOOGLEEARTH\""));
    }

    /// Parse every `<float_array id="geoN-pos-arr">` (one per chunk) into vertices.
    fn parse_positions(xml: &str) -> Vec<[f32; 3]> {
        let mut out: Vec<f32> = Vec::new();
        let mut rest = xml;
        while let Some(at) = rest.find("<float_array") {
            let s = &rest[at..];
            let tag_end = s.find('>').unwrap();
            let close = s.find("</float_array>").unwrap();
            if s[..tag_end].contains("-pos-arr") {
                out.extend(s[tag_end + 1..close].split_whitespace().map(|t| t.parse::<f32>().unwrap()));
            }
            rest = &s[close + "</float_array>".len()..];
        }
        out.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
    }

    /// The largest `<float_array>` text node, in bytes — the value strict XML
    /// parsers cap (libxml2 / Google Earth at ~10 MB).
    fn max_float_array_bytes(xml: &str) -> usize {
        let mut max = 0;
        let mut rest = xml;
        while let Some(at) = rest.find("<float_array") {
            let s = &rest[at..];
            let open = s.find('>').unwrap() + 1;
            let close = s.find("</float_array>").unwrap();
            max = max.max(close - open);
            rest = &s[close..];
        }
        max
    }

    fn hbounds(verts: &[[f32; 3]]) -> (f32, f32) {
        let (mut mnx, mut mxx, mut mny, mut mxy) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for v in verts {
            mnx = mnx.min(v[0]);
            mxx = mxx.max(v[0]);
            mny = mny.min(v[1]);
            mxy = mxy.max(v[1]);
        }
        ((mnx + mxx) / 2.0, (mny + mxy) / 2.0) // (X centre, Y centre)
    }

    #[test]
    fn converts_yup_to_zup_and_centers() {
        // Y-up input vertex (0,1,0) ("up") must land at Z-up Z=1 (up preserved), and the
        // geometry is centred on its horizontal AABB so the .dae origin == geometry centre.
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 0.0, 1.0], 3).flatten().collect();
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &[0, 1, 2], &[3], &[3], &[0.5, 0.5, 0.5, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        let verts = parse_positions(&xml);
        assert!(verts.iter().any(|v| (v[2] - 1.0).abs() < 1e-4), "Y-up (0,1,0) -> Z-up Z=1");
        let (cx, cy) = hbounds(&verts);
        assert!(cx.abs() < 1e-4 && cy.abs() < 1e-4, "geometry centred: ({cx}, {cy})");
    }

    #[test]
    fn centers_geometry_far_from_origin() {
        // A model whose geometry sits ~100-200 m from the local/survey origin must be
        // re-centred so the .dae origin == geometry centre — the point the KMZ <Location>
        // is computed for. This is the CH1903+/LV95 ~250 m offset fix (#1427).
        let positions = vec![
            100.0, 0.0, 200.0, 110.0, 0.0, 200.0, 110.0, 0.0, 220.0, 100.0, 0.0, 220.0,
        ];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &[0, 1, 2, 0, 2, 3], &[4], &[6], &[0.6, 0.6, 0.6, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        let (cx, cy) = hbounds(&parse_positions(&xml));
        assert!(cx.abs() < 1e-3, "X re-centred to ~0 (geometry was ~105 from origin): {cx}");
        assert!(cy.abs() < 1e-3, "Y re-centred to ~0 (geometry was ~210 from origin): {cy}");
    }

    #[test]
    fn deduplicates_shared_vertices() {
        // A quad supplied NON-indexed as two triangles (6 vertices: a,b,c and a,c,d)
        // collapses to 4 unique — a and c are shared with identical position+normal.
        // This is the lever that shrinks per-face IFC meshes under Google Earth's
        // vertex/triangle limits (#1427).
        let (a, b, c, d) = ([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0], [0.0, 0.0, 1.0]);
        let mut positions = vec![];
        for v in [a, b, c, a, c, d] {
            positions.extend_from_slice(&v);
        }
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 6).flatten().collect();
        let indices: Vec<u32> = (0..6).collect();
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &indices, &[6], &[6], &[0.5, 0.5, 0.5, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        assert_eq!(parse_positions(&xml).len(), 4, "6 input verts dedupe to 4 unique");
    }

    #[test]
    fn large_model_is_chunked_into_small_text_nodes() {
        // >MAX_VERTS unique vertices must split into multiple <geometry> chunks so no
        // single <float_array> is a huge XML text node. Strict XML parsers (libxml2 and
        // Google Earth) reject a text node over ~10 MB, which made large models load but
        // render INVISIBLE (#1427). One 25k-triangle / 75k-vertex mesh exceeds the 60k
        // per-chunk cap and must produce ≥2 geometries, all parser-safe.
        let vcount = 75_000usize; // > MAX_VERTS (60k)
        let mut positions = Vec::with_capacity(vcount * 3);
        let mut normals = Vec::with_capacity(vcount * 3);
        let mut indices = Vec::with_capacity(vcount);
        for i in 0..vcount {
            let f = i as f32 * 0.01;
            positions.extend_from_slice(&[f, 1.0, -f]);
            normals.extend_from_slice(&[0.0, 1.0, 0.0]);
            indices.push(i as u32);
        }
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &indices, &[vcount as u32], &[vcount as u32],
            &[0.5, 0.5, 0.5, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        assert!(xml.matches("<geometry ").count() >= 2, "geometry split into ≥2 chunks");
        // All vertices survive the split (75k in, 75k out across chunks).
        assert_eq!(parse_positions(&xml).len(), vcount, "no vertices dropped by chunking");
        assert!(
            max_float_array_bytes(&xml) < 5_000_000,
            "largest float_array stays small: {} bytes",
            max_float_array_bytes(&xml)
        );
        // Each <triangles count="N"> stays under Google Earth's 16-bit ceiling (21,845).
        let max_tri = xml
            .match_indices("<triangles ")
            .map(|(i, _)| {
                let tag = &xml[i..i + xml[i..].find('>').unwrap()];
                let c = tag.find("count=\"").unwrap() + 7;
                tag[c..tag[c..].find('"').unwrap() + c].parse::<usize>().unwrap()
            })
            .max()
            .unwrap();
        assert!(max_tri <= 21_845, "no <triangles> over the 16-bit ceiling: {max_tri}");
    }

    #[test]
    fn triangles_count_matches_index_list_on_ragged_input() {
        // A malformed index count (not a multiple of 3) must not desync the emitted
        // <triangles count> from the <p> list — keep only whole triangles.
        let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.5, 0.0, 0.5];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 4).flatten().collect();
        let indices = vec![0u32, 1, 2, 0, 2]; // 5 indices = one whole triangle + a stray pair
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &indices, &[4], &[5], &[0.3, 0.3, 0.3, 1.0], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        // Exactly one triangle survives; its <p> holds 3 vertex+normal index pairs (6 ints).
        assert!(xml.contains("<triangles material=\"sym0\" count=\"1\">"));
        let p_start = xml.find("<p>").unwrap() + 3;
        let p = &xml[p_start..xml[p_start..].find("</p>").unwrap() + p_start];
        assert_eq!(p.split_whitespace().count(), 6, "one triangle = 3 pairs = 6 indices: {p}");
    }

    #[test]
    fn translucent_material_emits_transparency() {
        let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 3).flatten().collect();
        let xml = String::from_utf8(export_collada_from_meshes(
            &positions, &normals, &[0, 1, 2], &[3], &[3], &[0.0, 1.0, 0.0, 0.5], &[0.0, 0.0, 0.0],
        ))
        .unwrap();
        assert!(xml.contains("<transparency>"));
        assert!(xml.contains("opaque=\"A_ONE\""));
    }
}
