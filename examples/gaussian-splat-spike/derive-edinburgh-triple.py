# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Derive the #8567 Edinburgh metric scan fixtures.

Run with Python -I and pye57, numpy, open3d, laspy[lazrs], scipy,
plyfile, and ifcopenshell. Input bytes are pinned below. No registration,
rescaling of the scan, or IFC source modification is performed.

The installed IfcOpenShell cannot load IFC4X1. For the measurement only,
the schema header is substituted in memory with IFC4; all wall/slab geometry
uses the common entity definitions. The published IFC bytes stay intact.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import ifcopenshell
import ifcopenshell.geom
import laspy
import numpy as np
import open3d as o3d
import pye57
from plyfile import PlyData, PlyElement
from scipy.spatial import cKDTree


SOURCE_HASHES = {
    "model.ifc": "d563b782a324d202f8e584d2a7c776508189e34d2b211b72eb13ea00d252f740",
    "cloud_coloured.e57": "683b9fdb72a2e803ded37bc8f30056396eed2e7529cbe68f5c14a15f48cf6eb3",
}
LAZ_VOXEL_M = 0.012  # Apartment scan recipe
SPLAT_VOXEL_M = 0.048  # 32-bit SH3 PLY stays below 150 MB
SAMPLE_COUNT = 50_000
SH_C0 = 0.28209479177387814


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return {"size": path.stat().st_size, "sha256": h.hexdigest()}


def downsample(xyz, rgb, voxel):
    cloud = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz))
    cloud.colors = o3d.utility.Vector3dVector(rgb.astype(np.float64) / 255.0)
    small = cloud.voxel_down_sample(voxel)
    points = np.asarray(small.points)
    colors = np.asarray(small.colors)
    # Open3D's voxel traversal order is unspecified; sort before serializing.
    order = np.lexsort((points[:, 2], points[:, 1], points[:, 0]))
    return points[order], colors[order]


def write_laz(path, points, colors):
    header = laspy.LasHeader(point_format=7, version="1.4")
    header.scales = np.array([0.0001] * 3)
    header.offsets = np.floor(points.min(axis=0))
    las = laspy.LasData(header)
    las.x, las.y, las.z = points[:, 0], points[:, 1], points[:, 2]
    rgb16 = np.rint(np.clip(colors, 0, 1) * 65535).astype(np.uint16)
    las.red, las.green, las.blue = rgb16[:, 0], rgb16[:, 1], rgb16[:, 2]
    las.write(path)


def write_splats(path, points, colors):
    # A scan-derived isotropic surface proxy, not a trained photogrammetric 3DGS.
    # Full SH3 columns are present; higher-order coefficients are zero because
    # the single scan does not establish view-dependent radiance.
    names = (["x", "y", "z", "nx", "ny", "nz"]
             + [f"f_dc_{i}" for i in range(3)]
             + [f"f_rest_{i}" for i in range(45)]
             + ["opacity"] + [f"scale_{i}" for i in range(3)]
             + [f"rot_{i}" for i in range(4)])
    rows = np.zeros(len(points), dtype=[(name, "<f4") for name in names])
    for i, name in enumerate(("x", "y", "z")):
        rows[name] = points[:, i]
    for i in range(3):
        rows[f"f_dc_{i}"] = (colors[:, i] - 0.5) / SH_C0
        rows[f"scale_{i}"] = math.log(SPLAT_VOXEL_M / 2.5)
    rows["nz"] = 1.0
    rows["opacity"] = math.log(0.95 / 0.05)
    rows["rot_0"] = 1.0
    PlyData([PlyElement.describe(rows, "vertex")], byte_order="<").write(path)


def ifc_wall_slab_mesh(path):
    source = path.read_text()
    old, new = "FILE_SCHEMA (('IFC4X1'))", "FILE_SCHEMA (('IFC4'))"
    if source.count(old) != 1:
        raise ValueError("unexpected IFC schema header")
    model = ifcopenshell.file.from_string(source.replace(old, new, 1))
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    verts, faces = [], []
    for element in model.by_type("IfcProduct"):
        if element.is_a() not in ("IfcWall", "IfcWallStandardCase", "IfcSlab"):
            continue
        shape = ifcopenshell.geom.create_shape(settings, element)
        v = np.asarray(shape.geometry.verts, dtype=np.float32).reshape(-1, 3)
        f = np.asarray(shape.geometry.faces, dtype=np.int32).reshape(-1, 3)
        faces.append(f + sum(len(item) for item in verts))
        verts.append(v)
    if not verts:
        raise ValueError("IFC has no wall/slab geometry")
    return np.concatenate(verts), np.concatenate(faces)


def bounds(points):
    return np.array([points.min(axis=0), points.max(axis=0)])


def aabb_iou(a, b):
    intersection = np.maximum(0, np.minimum(a[1], b[1]) - np.maximum(a[0], b[0])).prod()
    return float(intersection / (np.prod(a[1] - a[0]) + np.prod(b[1] - b[0]) - intersection))


def measure(scan, splat_points, vertices, faces):
    rng = np.random.default_rng(8567)
    ids = rng.choice(len(scan), min(SAMPLE_COUNT, len(scan)), replace=False)
    sample = scan[ids].astype(np.float32)
    mesh = o3d.t.geometry.TriangleMesh(
        o3d.core.Tensor(vertices), o3d.core.Tensor(faces))
    scene = o3d.t.geometry.RaycastingScene(nthreads=2)
    scene.add_triangles(mesh)
    wall_dist = scene.compute_distance(o3d.core.Tensor(sample), nthreads=2).numpy()
    band = wall_dist[wall_dist < 0.15]
    splat_dist = cKDTree(splat_points).query(sample, workers=2)[0]
    ib, sb = bounds(vertices), bounds(scan)
    return {
        "frame": "source identity; IFC millimetres resolved to metres by IfcOpenShell; E57 metres, Z-up",
        "ifc_measurement_schema_substitution": "IFC4X1 to IFC4 in memory only",
        "sample_seed": 8567,
        "sample_count": len(sample),
        "ifc_triangles": len(faces),
        "ifc_wall_slab_bounds_m": ib.tolist(),
        "scan_bounds_m": sb.tolist(),
        "splat_bounds_m": bounds(splat_points).tolist(),
        "ifc_scan_aabb_iou": aabb_iou(ib, sb),
        "wall_slab_band_lt_0_15m": {
            "count": len(band), "fraction": float(len(band) / len(sample)),
            "median_m": float(np.median(band)),
            "p90_m": float(np.percentile(band, 90)),
        },
        "scan_to_nearest_splat_center_m": {
            "median_m": float(np.median(splat_dist)),
            "p90_m": float(np.percentile(splat_dist, 90)),
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    for name, expected in SOURCE_HASHES.items():
        if digest(args.source_dir / name)["sha256"] != expected:
            raise ValueError(f"source SHA-256 mismatch: {name}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    e57 = pye57.E57(str(args.source_dir / "cloud_coloured.e57"))
    if e57.scan_count != 1:
        raise ValueError("expected exactly one E57 scan")
    header = e57.get_header(0)
    if not np.array_equal(header.translation, [0, 0, 0]) or not np.array_equal(header.rotation, [1, 0, 0, 0]):
        raise ValueError("nonidentity scan pose needs separate analysis")
    raw = e57.read_scan_raw(0)
    xyz = np.column_stack([raw[f"cartesian{axis}"] for axis in "XYZ"])
    rgb = np.column_stack([raw[f"color{channel}"] for channel in ("Red", "Green", "Blue")])
    if not np.isfinite(xyz).all():
        raise ValueError("nonfinite scan points")
    laz_points, laz_colors = downsample(xyz, rgb, LAZ_VOXEL_M)
    laz_path = args.output_dir / "edinburgh-synthetic-scan-vox12mm.laz"
    write_laz(laz_path, laz_points, laz_colors)
    splat_points, splat_colors = downsample(xyz, rgb, SPLAT_VOXEL_M)
    ply_path = args.output_dir / "edinburgh-synthetic-scan-sh3.ply"
    write_splats(ply_path, splat_points, splat_colors)
    vertices, faces = ifc_wall_slab_mesh(args.source_dir / "model.ifc")
    result = {
        "recipe": {"laz_voxel_m": LAZ_VOXEL_M, "splat_voxel_m": SPLAT_VOXEL_M,
                   "splat_kind": "scan-derived isotropic SH3 container; zero higher-order coefficients"},
        "sources": {name: digest(args.source_dir / name) for name in SOURCE_HASHES},
        "derivatives": {p.name: {**digest(p), "count": count} for p, count in
                        ((laz_path, len(laz_points)), (ply_path, len(splat_points)))},
        "alignment": measure(xyz, splat_points, vertices, faces),
    }
    report = args.output_dir / "edinburgh-measurement.json"
    report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
