# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent IFC/PNG reading of the actual WASM transfer plan (#4381).

Requires NumPy, Pillow, IfcOpenShell, Node and freshly built WASM. Applies only
canonical returned mutations via the independent reader; not a production writer.
Controlled observations prove UV orientation/background, not real scan accuracy.
"""
import base64
import io
import json
import subprocess
from pathlib import Path
import ifcopenshell
import ifcopenshell.geom
import numpy as np
from PIL import Image

javascript = """
import {readFileSync} from 'node:fs';
import {initSync,IfcAPI} from './packages/wasm/pkg/ifc-lite.js';
import {transferIfc,transferFixture,transferPixels,unpackTransfer} from './scripts/lib/wasm-mesh-transfer-contract.mjs';
initSync({module:readFileSync('./packages/wasm/pkg/ifc-lite_bg.wasm')});
const api=new IfcAPI();
try {
 const request=transferFixture(api);
 const {metadata,png}=unpackTransfer(api.planMeshTransfer(new TextEncoder().encode(transferIfc),JSON.stringify(request),transferPixels));
 process.stdout.write(JSON.stringify({source:transferIfc,request,metadata,png:Buffer.from(png).toString('base64')}));
} finally {api.free();}
"""
run = subprocess.run(['node', '--input-type=module', '-e', javascript],
                     cwd=Path(__file__).resolve().parents[2], text=True,
                     capture_output=True, check=True)
data = json.loads(run.stdout)
model = ifcopenshell.file.from_string(data['source'])
plan = data['metadata']['plan']
created = {entity['expressId']: model.create_entity(entity['type']) for entity in plan['created']}

def value(v):
    if isinstance(v, list):
        return tuple(value(item) for item in v)
    if isinstance(v, str):
        if v.startswith('#'):
            index = int(v[1:])
            return created[index] if index in created else model.by_id(index)
        if v.startswith('.') and v.endswith('.'):
            return {'T': True, 'F': False}.get(v[1:-1], v[1:-1])
        if v == '*':
            return None
    return v

for entity in plan['created']:
    for index, attribute in enumerate(entity['attributes']):
        created[entity['expressId']][index] = value(attribute)
for edit in plan['edits']:
    model.by_id(edit['expressId'])[edit['index']] = value(edit['value'])
for index in plan['removed']:
    model.remove(model.by_id(index))
# Reparse serialized IFC and use independent geometry, not planner preview arrays.
model = ifcopenshell.file.from_string(model.to_string())
product = model.by_type('IfcBuildingElementProxy')[0]
shape = ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(), product)
verts = np.array(shape.geometry.verts).reshape(-1, 3)
faces = np.array(shape.geometry.faces).reshape(-1, 3)
assert len(faces) == 1
assert np.allclose(sorted(map(tuple, verts)), [(0., 0., 0.), (0., 1., 0.), (1., 0., 0.)])
texture_map = model.by_type('IfcIndexedTriangleTextureMap')[0]
uvs = np.array(texture_map.TexCoords.TexCoordsList)
indices = np.array(texture_map.TexCoordIndex[0]) - 1
pixels = np.array(Image.open(io.BytesIO(base64.b64decode(data['png'])))).astype(float) / 255
height, width, _ = pixels.shape
source_pixels = np.array([[[1, 0, 0, 1], [0, 1, 0, 1]], [[0, 0, 1, 1], [1, 1, 1, 1]]], dtype=float)

def bilinear(image, uv):
    h, w, _ = image.shape
    x, y = np.array(uv) * [w, h] - .5
    x0, y0 = int(np.floor(x)), int(np.floor(y))
    tx, ty = x - x0, y - y0
    at = lambda a, b: image[np.clip(b, 0, h-1), np.clip(a, 0, w-1)]
    return (at(x0, y0)*(1-tx)+at(x0+1, y0)*tx)*(1-ty)+(at(x0, y0+1)*(1-tx)+at(x0+1, y0+1)*tx)*ty

worst = 0.
# Interior points avoid the explicitly unknown distance/coverage boundary.
for x, y in [(0.26, 0.26), (0.42, 0.25), (0.25, 0.42), (0.32, 0.32), (0.05, 0.1)]:
    target_uv = np.array([1-x-y, x, y]) @ uvs[indices]
    actual = bilinear(pixels, [target_uv[0], 1-target_uv[1]])
    expected = bilinear(source_pixels, [(x-.2)/.4, (y-.2)/.4]) if x >= .2 else np.array([.2, .4, .6, 1.])
    error = float(np.max(abs(actual-expected)))
    assert error < .025, (x, y, actual.tolist(), expected.tolist())
    worst = max(worst, error)
print(json.dumps(dict(oracle='IfcOpenShell independent IFC/geometry + Pillow PNG + NumPy bilinear reference',
    fixture='controlled partial triangle observation; not real scan registration accuracy',
    triangles=len(faces), sampled_points=5, max_channel_error=worst,
    ifcopenshell=ifcopenshell.version, coverage=data['metadata']['transfer']['coverage']), indent=2))
