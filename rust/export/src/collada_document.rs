// SPDX-License-Identifier: MPL-2.0
//! Serialising collected COLLADA geometry into the 1.4.1 document itself.
//!
//! Split out of `collada.rs` (which collects and transforms the geometry) so
//! that module comes back under the 400-line house rule and can be dropped from
//! the module-size allowlist. The code moved verbatim; the bytes it writes are
//! unchanged.
//!
//! The chunking rules, and why a single big `<float_array>` is a bug rather
//! than a size question, are on [`write_dae`].

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::collada_fmt::append_floats;

/// Serialise the collected geometry + materials into a COLLADA 1.4.1 document.
///
/// The geometry is split into multiple `<geometry>` chunks so that no single
/// `<float_array>` becomes a huge XML text node. Strict XML parsers (libxml2 and,
/// in practice, Google Earth) reject a text node larger than ~10 MB, so a big model
/// emitted as one array fails to parse and renders nothing — the "model loads but is
/// invisible" failure on large models (#1427). Each chunk is self-contained (its own
/// POSITION/NORMAL sources, re-indexed chunk-local) so no triangle spans a chunk.
pub(crate) fn write_dae(
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
