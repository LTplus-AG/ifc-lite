#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Write a quantity schedule joining attributes to tessellated geometry.

Shows the two exports sharing one key: `entity_data()["entities"]` and
`geometry_data_buffers()["elements"]` are both dicts keyed by IFC STEP id, so a
row and its mesh line up without any matching logic.

Stdlib only -- no numpy.

Usage:
    python schedule_csv.py model.ifc schedule.csv [quality]
"""

import csv
import struct
import sys

import ifclite_geom


def mesh_stats(element):
    """Vertex and triangle counts straight from the raw buffers."""
    # f64 xyz triplets -> 24 bytes per vertex; u32 triangle indices -> 12 per face.
    return len(element["vertices"]) // 24, len(element["faces"]) // 12


def bounding_box(element):
    """Axis-aligned bounds in absolute world metres.

    The export folds `rtc_offset` back into every vertex, so these are absolute
    even on a georeferenced model, in the same frame as `entity_data`
    placements.
    """
    verts = struct.unpack(f"<{len(element['vertices']) // 8}d", element["vertices"])
    xs, ys, zs = verts[0::3], verts[1::3], verts[2::3]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1

    ifc_path, out_path = sys.argv[1], sys.argv[2]
    quality = sys.argv[3] if len(sys.argv) > 3 else None

    with open(ifc_path, "rb") as f:
        ifc_bytes = f.read()

    geom = ifclite_geom.geometry_data_buffers(ifc_bytes, quality)
    ents = ifclite_geom.entity_data(ifc_bytes)

    # Dimensional property/quantity values are in the FILE's units; geometry is
    # always metres. Carry the scale so the two columns mean the same thing.
    scale = ents["length_unit_scale"]

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "step_id", "ifc_type", "global_id", "name",
            "vertices", "triangles", "height_m",
            "quantity", "quantity_value_m", "property_sets",
        ])

        for step_id, el in geom["elements"].items():
            row = ents["entities"].get(step_id)
            nverts, ntris = mesh_stats(el)
            (_, _, zmin), (_, _, zmax) = bounding_box(el)

            # First length quantity on the row, converted to metres.
            qname, qvalue = "", ""
            if row:
                for qs in row["quantity_sets"]:
                    for q in qs["quantities"]:
                        if q["kind"] == "Length":
                            qname = f"{qs['name']}.{q['name']}"
                            qvalue = f"{q['value'] * scale:.4f}"
                            break
                    if qname:
                        break

            w.writerow([
                step_id,
                el["ifc_type"],
                el["global_id"] or "",
                (row["name"] if row else el["name"]) or "",
                nverts,
                ntris,
                f"{zmax - zmin:.4f}",
                qname,
                qvalue,
                ";".join(ps["name"] for ps in row["property_sets"]) if row else "",
            ])

    matched = sum(1 for k in geom["elements"] if k in ents["entities"])
    print(f"wrote {out_path}: {geom['element_count']} meshed elements, "
          f"{matched} joined to an attribute row "
          f"(of {ents['entity_count']} rows total)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
