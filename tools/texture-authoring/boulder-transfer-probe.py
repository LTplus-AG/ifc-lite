# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Offline #4381 ambiguity/budget probe on an already-created boulder IFCZIP.

Usage: python3 boulder-transfer-probe.py source.glb captured.ifczip [triangles]
This is known-derived self-transfer, never independent scan registration evidence.
Requires IfcOpenShell, NumPy, SciPy, Pillow and rebuilt WASM. No network or writes.
The deliberately narrow fixture decoder accepts only the qualified albedo GLB.
"""
import base64
import hashlib
import io
import json
import struct
import subprocess
import sys
import zipfile
from pathlib import Path
import ifcopenshell
import ifcopenshell.util.placement
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

root = Path(__file__).resolve().parents[2]
glb = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(glb).hexdigest() == 'b6a0b51894427c37505632f4d4513d0424f0d84b014554755aa53eb74af6dcd6', 'Use documented albedo-only boulder fixture'
size = struct.unpack_from('<I', glb, 12)[0]
document = json.loads(glb[20:20+size])
start = 20 + size + 8

def accessor(index):
    spec = document['accessors'][index]
    view = document['bufferViews'][spec['bufferView']]
    width = {'VEC3': 3, 'VEC2': 2, 'SCALAR': 1}[spec['type']]
    dtype = {5126: '<f4', 5125: '<u4', 5123: '<u2'}[spec['componentType']]
    assert 'byteStride' not in view
    return np.frombuffer(glb, dtype=dtype, count=spec['count']*width,
                         offset=start+view.get('byteOffset', 0)+spec.get('byteOffset', 0)).reshape(-1, width)

positions = accessor(0).astype(float)
uvs = accessor(2).astype(float)
triangles = accessor(3).reshape(-1, 3).astype(int)
with zipfile.ZipFile(sys.argv[2]) as archive:
    source = archive.read(next(name for name in archive.namelist() if name.endswith('.ifc'))).decode()
model = ifcopenshell.file.from_string(source)
product = model.by_guid('3F8ea83w95POWKkSYP6ukU')
item = product.Representation.Representations[0].Items[0]
original_count = len(item.CoordIndex)
limit = int(sys.argv[3]) if len(sys.argv) > 3 else original_count
assert 0 < limit <= original_count
if limit < original_count:
    item.CoordIndex = item.CoordIndex[:limit]
    for mapping in item.HasTextures:
        if mapping.TexCoordIndex is not None:
            mapping.TexCoordIndex = mapping.TexCoordIndex[:limit]
    source = model.to_string()
points = np.array(item.Coordinates.CoordList)
placement = ifcopenshell.util.placement.get_local_placement(product.ObjectPlacement)
world = points @ placement[:3, :3].T + placement[:3, 3]
known_target = positions[:, [0, 2, 1]].copy()
known_target[:, 1] *= -1
residuals, _ = cKDTree(known_target).query(world)
assert residuals.max() < 1e-12, 'Target must be demonstrably derived from this exact source'
selected = np.linspace(0, len(positions)-1, 8, dtype=int)
pairs = [dict(id=f'p{k}', sourceObservation=f'glb-vertex:{i}', targetFeature=f'known-derived-point:{i}',
              source=positions[i].tolist(), target=known_target[i].tolist()) for k, i in enumerate(selected)]
view = document['bufferViews'][document['images'][0]['bufferView']]
image_bytes = glb[start+view.get('byteOffset', 0):start+view.get('byteOffset', 0)+view['byteLength']]
image = Image.open(io.BytesIO(image_bytes)).convert('RGBA')
rgba = image.tobytes()
raster = dict(width=image.width, height=image.height, byteOffset=0, byteLength=len(rgba))
uri = model.by_type('IfcImageTexture')[0].URLReference
request = dict(schema='IFC4', sourceRevision='controlled-boulder-derived-self-transfer',
    nextExpressId=max(entity.id() for entity in model)+1, productIds=[product.id()],
    registration=dict(sourceFrame=dict(assetSha256=hashlib.sha256(glb).hexdigest(), frameKey='original-glb-y-up'),
        targetFrame=dict(assetSha256=hashlib.sha256(source.encode()).hexdigest(), frameKey='known-derived-ifc-z-up'), fit=pairs[:4], heldOut=pairs[4:]),
    registrationSha256='', targetFromIfcWorld=dict(rotation=[[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor=[0, 0, 0], targetAnchor=[0, 0, 0]),
    sourceMesh=dict(meshOrdinal=0, positions=positions.tolist(), triangles=triangles.tolist(), uvs=uvs.tolist(),
        baseColorFactor=[1, 1, 1, 1], repeatS=True, repeatT=True),
    sourceImage=raster, sourceImages=[dict(imageUri=uri, raster=raster)], texelsPerMetre=16,
    maxDistanceMetres=0.001, minNormalDot=0.9, ambiguityDistanceMetres=0.0001)
javascript = """
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {initSync,IfcAPI} from './packages/wasm/pkg/ifc-lite.js';
import {unpackTransfer} from './scripts/lib/wasm-mesh-transfer-contract.mjs';
initSync({module:readFileSync('./packages/wasm/pkg/ifc-lite_bg.wasm')});const api=new IfcAPI();
try {
 const {request,source,rgba}=JSON.parse(readFileSync(0,'utf8'));
 request.registrationSha256=JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(request.registration)))).requestSha256;
 try {
  const bytes=api.planMeshTransfer(new TextEncoder().encode(source),JSON.stringify(request),Buffer.from(rgba,'base64'));
  const result=unpackTransfer(bytes);
  console.log(JSON.stringify({transfer:result.metadata.transfer,assets:result.metadata.assets,pngBytes:result.png.length,ifpaSha256:createHash('sha256').update(bytes).digest('hex'),pngSha256:createHash('sha256').update(result.png).digest('hex')}));
 } catch(error) { console.log(JSON.stringify({refusal:error.message})); }
} finally {api.free();}
"""
run = subprocess.run(['node', '--input-type=module', '-e', javascript],
    input=json.dumps(dict(request=request, source=source, rgba=base64.b64encode(rgba).decode())),
    capture_output=True, text=True, cwd=root, check=True)
result = json.loads(run.stdout)
result.update(sourceTriangles=len(triangles), targetTriangles=limit, originalTargetTriangles=original_count,
    targetTriangleOrdinals=[0, limit-1], sourceGlbSha256=hashlib.sha256(glb).hexdigest(),
    ifcSha256=hashlib.sha256(source.encode()).hexdigest(), knownDerivedCoordinateMaxDelta=float(residuals.max()))
print(json.dumps(result, indent=2))
