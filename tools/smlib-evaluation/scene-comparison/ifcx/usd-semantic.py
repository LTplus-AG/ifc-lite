# SPDX-License-Identifier: MPL-2.0
"""Consume actual USD artifacts with OpenUSD; compare typed scene semantics."""
import hashlib,json,struct,sys
from pathlib import Path
from pxr import Usd,UsdGeom,UsdShade,Sdf

def encode(value):
    if value is None or isinstance(value,(str,bool,int)):return value
    if isinstance(value,float):return {'float64le':struct.pack('<d',value).hex()}
    if isinstance(value,dict):return {str(key):encode(item) for key,item in sorted(value.items())}
    if isinstance(value,Sdf.Path):return {'path':str(value)}
    if isinstance(value,Sdf.AssetPath):return {'asset':value.path,'resolved':value.resolvedPath}
    if isinstance(value,Sdf.Reference):return {'assetPath':value.assetPath,'primPath':str(value.primPath),'layerOffset':str(value.layerOffset),'customData':encode(value.customData)}
    if hasattr(value,'GetAppliedItems'):return {'type':type(value).__name__,'applied':encode(value.GetAppliedItems())}
    if hasattr(value,'__iter__') or (hasattr(value,'__len__') and hasattr(value,'__getitem__')):return {'type':type(value).__name__,'values':[encode(item) for item in value]}
    # USD enum metadata has no mutable payload or buffer; keep its actual type
    # and symbolic value rather than inventing an equivalent default.
    if type(value).__module__=='pxr.Sdf':return {'type':type(value).__name__,'value':str(value)}
    raise TypeError(f'Unsupported USD field value {type(value)}')

def capture(path):
    stage=Usd.Stage.Open(str(path));assert stage,f'USD failed to open {path}'
    cache=UsdGeom.XformCache();prims=[]
    witness={'prims':0,'meshes':0,'triangles':0,'points':0,'uvMeshes':0,'materials':0,'materialBindings':0,'textureShaders':0,'ifcAttributes':0,'instances':0,'referencedPrims':0,'abstractPrims':0,'nonidentityWorldTransforms':0,'prototypes':len(stage.GetPrototypes())}
    for prim in stage.TraverseAll():
        witness['prims']+=1
        attrs=[]
        for attr in prim.GetAttributes():
            attrs.append({'name':attr.GetName(),'type':str(attr.GetTypeName()),'custom':attr.IsCustom(),
                          'authored':attr.HasAuthoredValueOpinion(),'metadata':encode(attr.GetAllMetadata()),
                          'value':encode(attr.Get()),'connections':[str(x) for x in attr.GetConnections()],
                          'timeSamples':[[time,encode(attr.Get(time))] for time in attr.GetTimeSamples()]})
            if attr.GetName().startswith('ifc:'):witness['ifcAttributes']+=1
        record={'path':str(prim.GetPath()),'type':prim.GetTypeName(),'metadata':encode(prim.GetAllMetadata()),
                'instance':prim.IsInstance(),'attributes':attrs,'relationships':[{'name':rel.GetName(),'targets':[str(x) for x in rel.GetTargets()],'metadata':encode(rel.GetAllMetadata())} for rel in prim.GetRelationships()]}
        if prim.IsInstance():witness['instances']+=1
        if prim.HasAuthoredReferences():witness['referencedPrims']+=1
        if prim.IsAbstract():witness['abstractPrims']+=1
        if prim.IsA(UsdGeom.Xformable):
            matrix=cache.GetLocalToWorldTransform(prim);record['worldMatrix']=encode(matrix)
            if any(matrix[row][column] != float(row==column) for row in range(4) for column in range(4)):
                witness['nonidentityWorldTransforms']+=1
        if prim.IsA(UsdGeom.Mesh):
            mesh=UsdGeom.Mesh(prim);points=mesh.GetPointsAttr().Get();indices=mesh.GetFaceVertexIndicesAttr().Get();counts=mesh.GetFaceVertexCountsAttr().Get()
            valid,reason=UsdGeom.Mesh.ValidateTopology(indices,counts,len(points));assert valid,(path,str(prim.GetPath()),reason)
            witness['meshes']+=1;witness['points']+=len(points);witness['triangles']+=sum(count-2 for count in counts)
            uv=prim.GetAttribute('primvars:st')
            if uv and uv.Get():witness['uvMeshes']+=1
            material,_=UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()
            if material:witness['materialBindings']+=1;record['boundMaterial']=str(material.GetPath())
        if prim.IsA(UsdShade.Material):witness['materials']+=1
        if prim.IsA(UsdShade.Shader) and UsdShade.Shader(prim).GetIdAttr().Get()=='UsdUVTexture':witness['textureShaders']+=1
        prims.append(record)
    assert witness['meshes']>0,f'{path} must contain actual mesh prims'
    assert UsdGeom.GetStageUpAxis(stage)=='Z'
    assert UsdGeom.GetStageMetersPerUnit(stage)==1
    return {'metadata':encode(stage.GetPseudoRoot().GetAllMetadata()),'prims':prims},witness

base,candidate,output=map(Path,sys.argv[1:]);output.mkdir(parents=True,exist_ok=True)
rows=[]
for path in sorted(base.glob('*.usda')):
    left,left_witness=capture(path);right,right_witness=capture(candidate/path.name)
    assert left==right,f'Semantic USD difference in {path.name}'
    assert left_witness==right_witness
    roundtrip=output/(path.stem+'.roundtrip.usda')
    source_stage=Usd.Stage.Open(str(candidate/path.name))
    assert source_stage.GetRootLayer().Export(str(roundtrip))
    replay,replay_witness=capture(roundtrip)
    assert replay==right and replay_witness==right_witness,f'OpenUSD roundtrip changed {path.name}'
    data=json.dumps(right,sort_keys=True,separators=(',',':')).encode()
    (output/(path.stem+'.json')).write_bytes(data+b'\n')
    rows.append({'name':path.stem,'semanticSha256':hashlib.sha256(data).hexdigest(),'witnesses':right_witness,'equal':True,'OpenUsdLayerRoundtripEqual':True})
assert len(rows)==7,'all requested real export cases must produce stages'
(output/'summary.json').write_text(json.dumps({'consumer':'OpenUSD','version':Usd.GetVersion(),'cases':rows,'scope':'actual public WASM STEP-to-USD export plus OpenUSD typed semantic consumption; not IFCX-to-USD export'},indent=2)+'\n')
print(json.dumps(rows,indent=2))
