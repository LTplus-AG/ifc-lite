#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent-reader oracle for PDF vector annotation provenance (#4406).

Opens an exported IFC with IfcOpenShell, finds every IfcAnnotation created by the
PDF vector planner (ObjectType `IfcLite:PdfVectorFills`) and prints its
Description plus the `IfcLite_PdfVectorConversion` property set as JSON. It
verifies that the accepted verdict survives export and reopen in a reader that
shares no code with ifc-lite.

With `plan.json` and `source.pdf` (written by `pdf-fidelity-evidence.mjs`) it
also renders the original page with MuPDF, antialiasing off, and compares every
pixel centre against two predictions: the native plan meshes (what the 3D scene
draws) and the exported `IfcAnnotationFillArea` boundaries as IfcOpenShell reads
them (what the 2D drawing draws). Every differing pixel must lie inside a
visible omission extent the report listed, or within one pixel of a native
boundary; a partial page must actually differ inside its reported extents. This
checks that the report locates what was left out. It is not a claim that the
converted subset resembles the page.

Usage: python3 tools/texture-authoring/pdf-fidelity-oracle.py exported.ifc [output.json [plan.json source.pdf]]
"""
import json
import sys
from pathlib import Path

import ifcopenshell
import ifcopenshell.util.element

PSET = "IfcLite_PdfVectorConversion"
RASTER_SCALE = 4


def describe(path):
    model = ifcopenshell.open(path)
    annotations = []
    for annotation in model.by_type("IfcAnnotation"):
        if annotation.ObjectType != "IfcLite:PdfVectorFills":
            continue
        psets = ifcopenshell.util.element.get_psets(annotation)
        provenance = psets.get(PSET)
        containers = [rel.RelatingStructure.Name for rel in (annotation.ContainedInStructure or [])]
        annotations.append({
            "expressId": annotation.id(),
            "GlobalId": annotation.GlobalId,
            "Name": annotation.Name,
            "Description": annotation.Description,
            "containedIn": containers,
            "representationItems": sum(len(r.Items) for r in annotation.Representation.Representations),
            "provenance": provenance,
        })
    return {"ifcopenshell": ifcopenshell.version, "schema": model.schema, "annotations": annotations}


def plane_uv(points_xyz, plan):
    """World IFC metres to the annotation plane's (u, v) metres."""
    import numpy as np

    frame = plan["frame"]
    rel = np.asarray(points_xyz, float) - np.asarray(frame["origin"], float)
    return np.stack((rel @ np.asarray(frame["axisU"], float), rel @ np.asarray(frame["axisV"], float)), axis=-1)


def uv_to_pdf(uv, plan):
    """Plane (u, v) metres back to unrotated PDF user space through the calibration affine."""
    import numpy as np

    a, b, c, d, e, f = plan["modelMetresFromPdf"]
    det = a * d - b * c
    u, v = uv[..., 0] - e, uv[..., 1] - f
    return np.stack(((d * u - c * v) / det, (-b * u + a * v) / det), axis=-1)


def paint_triangles(predicted, uv, tris_uv, rgb):
    """Paint every pixel whose plane point lies in one of the triangles."""
    import numpy as np

    hit = np.zeros(uv.shape[:2], bool)
    for a, b, c in tris_uv:
        u, v, q = b - a, c - a, uv - a
        den = u[0] * v[1] - u[1] * v[0]
        if den == 0:
            continue
        s = (q[..., 0] * v[1] - q[..., 1] * v[0]) / den
        t = (u[0] * q[..., 1] - u[1] * q[..., 0]) / den
        hit |= (s >= 0) & (t >= 0) & (s + t <= 1)
    predicted[hit] = np.rint(np.asarray(rgb[:3]) * 255).astype(np.uint8)


def raster_compare(model, plan_path, pdf_path, out_dir, stem):
    """MuPDF raster of the page versus the native meshes and the reopened fill areas."""
    import fitz
    import numpy as np
    from matplotlib.path import Path as MplPath
    from PIL import Image

    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    fitz.TOOLS.set_aa_level(0)
    document = fitz.open(pdf_path)
    page = document[plan["pageNumber"] - 1]
    scale = fitz.Matrix(RASTER_SCALE, RASTER_SCALE)
    pix = page.get_pixmap(matrix=scale, alpha=False)
    expected = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3]
    # Pixel centres back to unrotated PDF user space. The pixmap covers the
    # CropBox, rotated by the intrinsic /Rotate and scaled by UserUnit and the
    # render scale; the scale is taken from the pixmap so the derivation is
    # checked against MuPDF's own page size rather than assumed.
    x0, y0, x1, y1 = plan["viewBox"]
    rotation = plan["intrinsicRotation"] % 360
    width, height = (x1 - x0, y1 - y0) if rotation in (0, 180) else (y1 - y0, x1 - x0)
    assert abs(pix.w / width - pix.h / height) < 1e-6 and abs(pix.w / width - plan["userUnit"] * RASTER_SCALE) < 1e-6, (pix.w, pix.h, width, height)
    yy, xx = np.mgrid[: pix.h, : pix.w]
    px, py = (xx + 0.5) / (pix.w / width), (yy + 0.5) / (pix.h / height)
    # Rotated page (y down) back to unrotated page (y down), then to PDF user space.
    unrotated = {0: (px, py), 90: (py, (y1 - y0) - px), 180: ((x1 - x0) - px, (y1 - y0) - py), 270: ((x1 - x0) - py, px)}[rotation]
    pdf_xy = np.stack((unrotated[0] + x0, y1 - unrotated[1]), axis=-1)
    a, b, c, d, e, f = plan["modelMetresFromPdf"]
    uv = np.stack((a * pdf_xy[..., 0] + c * pdf_xy[..., 1] + e, b * pdf_xy[..., 0] + d * pdf_xy[..., 1] + f), axis=-1)
    # Prediction 1: the native plan meshes, in paint order.
    native = np.full_like(expected, 255)
    for mesh in plan["meshes"]:
        world = np.asarray(mesh["positions"], float).reshape(-1, 3) + np.asarray(mesh["origin"], float) + np.asarray(plan["rtcOffset"], float)
        tris = plane_uv(world, plan)[np.asarray(mesh["indices"], int).reshape(-1, 3)]
        paint_triangles(native, uv, tris, mesh["color"])
    # Prediction 2: the exported fill areas as IfcOpenShell reads them, in paint order.
    reader = np.full_like(expected, 255)
    edges = []
    flat = uv.reshape(-1, 2)
    for region in plan["regions"]:
        item = model.by_id(region["geometryItemId"])
        assert item.is_a("IfcAnnotationFillArea"), item
        colour = item.StyledByItem[0].Styles[0].FillStyles[0]
        assert [colour.Red, colour.Green, colour.Blue] == region["rgb"], region
        rings = [np.asarray([p.Coordinates[:2] for p in boundary.Points], float) for boundary in [item.OuterBoundary, *(item.InnerBoundaries or [])]]
        for ring in rings:
            edges.extend(zip(ring[:-1], ring[1:]))
        inside = MplPath(rings[0]).contains_points(flat)
        for hole in rings[1:]:
            inside &= ~MplPath(hole).contains_points(flat)
        reader[inside.reshape(uv.shape[:2])] = np.rint(np.asarray(region["rgb"]) * 255).astype(np.uint8)
    # Classify differing pixels: inside a reported visible extent, or on a native boundary.
    extents = [entry["bboxPdf"] for entry in plan["fidelity"]["summary"] if entry["visibleCount"] > 0 and entry["bboxPdf"]]
    slack = 1.0 / RASTER_SCALE
    in_extent = np.zeros(uv.shape[:2], bool)
    for x0, y0, x1, y1 in extents:
        in_extent |= (pdf_xy[..., 0] >= x0 - slack) & (pdf_xy[..., 0] <= x1 + slack) & (pdf_xy[..., 1] >= y0 - slack) & (pdf_xy[..., 1] <= y1 + slack)
    edge_pdf = [(uv_to_pdf(p, plan), uv_to_pdf(q, plan)) for p, q in edges]

    def boundary_distance(mask):
        points = pdf_xy[mask]
        if not len(points):
            return np.zeros(0)
        best = np.full(len(points), np.inf)
        for p, q in edge_pdf:
            v = q - p
            t = np.clip(((points - p) @ v) / (v @ v), 0, 1)
            best = np.minimum(best, np.linalg.norm(points - p - t[:, None] * v, axis=1))
        return best * RASTER_SCALE

    results = {}
    for name, predicted in (("native3d", native), ("reader2d", reader)):
        mismatch = np.any(np.abs(predicted.astype(np.int16) - expected.astype(np.int16)) > 1, axis=2)
        explained_by_extent = mismatch & in_extent
        distance = boundary_distance(mismatch & ~in_extent)
        near_boundary = int((distance <= 1.0).sum())
        unexplained = int((distance > 1.0).sum())
        results[name] = {
            "mismatchPixels": int(mismatch.sum()),
            "insideReportedExtent": int(explained_by_extent.sum()),
            "withinOnePixelOfNativeBoundary": near_boundary,
            "unexplained": unexplained,
            "maxBoundaryDistancePixels": float(distance.max()) if len(distance) else 0.0,
        }
        assert unexplained == 0, (name, results[name])
        if not plan["fidelity"]["exact"]:
            assert explained_by_extent.any(), f"{name}: a partial page must differ inside its reported extents"
        visual = np.full_like(expected, 255)
        visual[explained_by_extent] = (220, 40, 40)
        visual[mismatch & ~in_extent] = (40, 40, 220)
        Image.fromarray(visual).save(out_dir / f"{stem}-{name}-mismatch.png")
    Image.fromarray(expected).save(out_dir / f"{stem}-mupdf.png")
    Image.fromarray(native).save(out_dir / f"{stem}-native3d.png")
    Image.fromarray(reader).save(out_dir / f"{stem}-reader2d.png")
    both = np.any(np.abs(native.astype(np.int16) - reader.astype(np.int16)) > 1, axis=2)
    return {
        "mupdf": fitz.VersionBind,
        "renderScale": RASTER_SCALE,
        "pixelsCompared": int(pix.w * pix.h),
        "pixmap": [pix.w, pix.h],
        "rasterMode": "MuPDF antialiasing disabled; all pixel centres; one 8-bit quantization step allowed",
        "reportedVisibleExtentsPdf": extents,
        "native3dVersusReader2dPixels": int(both.sum()),
        "comparisons": results,
    }


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__)
    report = describe(argv[1])
    if not report["annotations"]:
        raise SystemExit("No PDF vector annotation in the exported IFC")
    for annotation in report["annotations"]:
        if not annotation["provenance"]:
            raise SystemExit(f"Annotation #{annotation['expressId']} has no {PSET} property set")
        omissions = json.loads(annotation["provenance"]["Omissions"])
        partial = annotation["provenance"]["AcceptedPartialConversion"]
        if partial != (not annotation["provenance"]["ExactConversion"]):
            raise SystemExit("ExactConversion and AcceptedPartialConversion disagree")
        if partial != any(entry.get("visible", 0) > 0 for entry in omissions):
            raise SystemExit("Recorded omissions disagree with the accepted verdict")
    if len(argv) > 4:
        out_path = Path(argv[2])
        stem = out_path.name.removesuffix("-oracle.json").removesuffix(".json")
        report["raster"] = raster_compare(ifcopenshell.open(argv[1]), argv[3], argv[4], out_path.parent, stem)
    rendered = json.dumps(report, indent=2)
    if len(argv) > 2:
        with open(argv[2], "w", encoding="utf-8") as handle:
            handle.write(rendered + "\n")
    print(rendered)


if __name__ == "__main__":
    main(sys.argv)
