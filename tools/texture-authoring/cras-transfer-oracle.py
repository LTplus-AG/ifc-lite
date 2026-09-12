# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent apply + reopen of a CRAS point-transfer plan (#4381).

Applies only the canonical WASM plan's created/edited/removed entities to the
tessellated IFC4 target with IfcOpenShell, writes the transferred IFC and its
PNG asset, then reopens the file independently: the target wall's geometry must
be unchanged, the texture map must index every triangle, and the atlas colours
sampled through the written UVs must match the WASM atlas at texel centres.
Not a production writer. Usage:
  python cras-transfer-oracle.py TARGET.ifc RUN_DIR LABEL WALL_GUID OUT_DIR
"""
import hashlib, io, json, pathlib, sys
import numpy as np
import ifcopenshell, ifcopenshell.geom
from PIL import Image

target_path, run_dir, label, wall_guid, out_dir = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4], pathlib.Path(sys.argv[5])
out_dir.mkdir(parents=True, exist_ok=True)
data = json.loads((run_dir / f'transfer-{label}.json').read_text())
plan = data['metadata']['plan']
png_bytes = (run_dir / f'transfer-{label}.png').read_bytes()
asset = data['metadata']['assets'][0]
assert hashlib.sha256(png_bytes).hexdigest() in asset['imageUri'], 'atlas PNG identity is its SHA-256 URI'
model = ifcopenshell.open(target_path)
settings = ifcopenshell.geom.settings(); settings.set(settings.USE_WORLD_COORDS, True); shapes = []
def verts_faces(entity):
    shape = ifcopenshell.geom.create_shape(settings, entity); shapes.append(shape)
    return np.array(shape.geometry.verts).reshape(-1, 3), np.array(shape.geometry.faces).reshape(-1, 3)
wall = model.by_guid(wall_guid)
before_v, before_f = verts_faces(wall)
created = {e['expressId']: model.create_entity(e['type']) for e in plan['created']}
def value(v):
    if isinstance(v, list): return tuple(value(i) for i in v)
    if isinstance(v, str):
        if v.startswith('#'):
            index = int(v[1:]); return created[index] if index in created else model.by_id(index)
        if v.startswith('.') and v.endswith('.'): return {'T': True, 'F': False}.get(v[1:-1], v[1:-1])
        if v == '*': return None
    return v
for e in plan['created']:
    for index, attribute in enumerate(e['attributes']): created[e['expressId']][index] = value(attribute)
for edit in plan['edits']: model.by_id(edit['expressId'])[edit['index']] = value(edit['value'])
for index in plan['removed']: model.remove(model.by_id(index))
ifc_out = out_dir / f'{target_path.stem}-transferred-{label}.ifc'
model.write(str(ifc_out))
(out_dir / 'textures').mkdir(exist_ok=True)
(out_dir / asset['imageUri']).write_bytes(png_bytes)
# Reopen independently and verify.
reopened = ifcopenshell.open(ifc_out)
wall2 = reopened.by_guid(wall_guid)
after_v, after_f = verts_faces(wall2)
geometry_identical = before_v.shape == after_v.shape and np.allclose(np.sort(before_v.round(9), axis=0), np.sort(after_v.round(9), axis=0)) and before_f.shape == after_f.shape
tfs = wall2.Representation.Representations[0].Items[0]
maps = [m for m in reopened.by_type('IfcIndexedTriangleTextureMap') if m.MappedTo == tfs]
assert len(maps) == 1, 'exactly one texture map for the transferred body'
texture_map = maps[0]
tex_index = np.array(texture_map.TexCoordIndex)
coord_index = np.array(tfs.CoordIndex)
uvs = np.array(texture_map.TexCoords.TexCoordsList)
image = texture_map.Maps[0]
styles = [s for s in reopened.by_type('IfcStyledItem') if s.Item == tfs]
textured = any(any(l.is_a('IfcSurfaceStyleWithTextures') for l in style.Styles) for si in styles for style in si.Styles)
pixels = np.array(Image.open(io.BytesIO(png_bytes)).convert('RGBA')).astype(float) / 255
height, width, _ = pixels.shape
# Colour at texel centres: the atlas encodes prior style (opaque beige) for unknowns
# and captured colour for observed texels; sample every triangle's UV centroid.
observed_like, prior_like, total = 0, 0, 0
prior = np.array([0.85, 0.84, 0.80])
def texel(uv):
    x = min(width - 1, max(0, int(uv[0] * width))); y = min(height - 1, max(0, int((1 - uv[1]) * height)))
    return pixels[y, x, :3]
for tri in tex_index:
    rgb = texel(uvs[tri - 1].mean(0)); total += 1
    if np.abs(rgb - prior).max() < 0.02: prior_like += 1
    else: observed_like += 1
# Which faces carry captured colour: sample a barycentric grid over every triangle
# and bucket by the triangle's geometric normal (world axes), so a wall's two
# faces are reported separately. This is what decides the side question.
coords = np.array(tfs.Coordinates.CoordList)
by_face = {}
grid = [(i / 12, j / 12) for i in range(1, 12) for j in range(1, 12 - i)]
for tri, tex in zip(coord_index, tex_index):
    a, b, c = coords[tri - 1]
    n = np.cross(b - a, c - a); n = n / (np.linalg.norm(n) or 1.0)
    axis = int(np.argmax(np.abs(n))); key = ('-' if n[axis] < 0 else '+') + 'xyz'[axis]
    entry = by_face.setdefault(key, {'triangles': 0, 'samples': 0, 'observed': 0})
    entry['triangles'] += 1
    ta, tb, tc = uvs[tex - 1]
    for u, v in grid:
        rgb = texel(ta + (tb - ta) * u + (tc - ta) * v); entry['samples'] += 1
        if np.abs(rgb - prior).max() >= 0.02: entry['observed'] += 1
for entry in by_face.values():
    entry['observed_fraction'] = round(entry['observed'] / entry['samples'], 3) if entry['samples'] else None
report = {
    'oracle': 'IfcOpenShell apply of the canonical plan + independent reopen; Pillow atlas decode',
    'ifcopenshell': ifcopenshell.version,
    'target': {'file': target_path.name, 'sha256': hashlib.sha256(target_path.read_bytes()).hexdigest()},
    'transferred': {'file': ifc_out.name, 'sha256': hashlib.sha256(ifc_out.read_bytes()).hexdigest(), 'bytes': ifc_out.stat().st_size, 'entities': len(list(reopened))},
    'asset': {'uri': asset['imageUri'], 'sha256': hashlib.sha256(png_bytes).hexdigest(), 'width': width, 'height': height},
    'wall': {'globalId': wall_guid, 'expressId': wall2.id(), 'triangles': int(len(coord_index)), 'vertices': int(len(before_v))},
    'checks': {
        'geometry_unchanged': bool(geometry_identical),
        'texture_map_covers_every_triangle': bool(tex_index.shape == coord_index.shape),
        'image_uri_matches_asset': image.URLReference == asset['imageUri'],
        'surface_style_with_textures_assigned': bool(textured),
        'triangle_uv_centroids_observed_like': observed_like, 'triangle_uv_centroids_prior_like': prior_like, 'triangles_sampled': total,
        'observed_by_face_normal': by_face,
        'schema_validation': None,
    },
}
try:
    import ifcopenshell.validate
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(reopened, logger, express_rules=False)
    report['checks']['schema_validation'] = {'errors': len(logger.statements), 'first': logger.statements[:3]}
except Exception as error:  # validation module availability differs across builds
    report['checks']['schema_validation'] = f'not run: {error}'
(out_dir / f'oracle-{label}.json').write_text(json.dumps(report, indent=1, default=str) + '\n')
print(json.dumps(report, indent=1, default=str))
