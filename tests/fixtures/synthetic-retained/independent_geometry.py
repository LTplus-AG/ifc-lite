#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Small-fixture IfcOpenShell geometry check; independent from generator/ifc-lite.

Run in an existing IfcOpenShell + numpy environment. This is not evidence that
ifc-lite passed its own tests. Also integrates the source-defined band section
numerically, without using the generator's antiderivative.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def source_volumes(model, case):
    # Independently read IFC inputs. Do not import generator or reuse its helper.
    usage = model.by_type('IfcMaterialLayerSetUsage')[0]
    thicknesses = [layer.LayerThickness for layer in usage.ForLayerSet.MaterialLayers]
    axis = model.by_type('IfcWall')[0].Representation.Representations[1].Items[0]
    radius = axis.BasisCurve.Radius
    span = axis.Trim2[0].wrappedValue-axis.Trim1[0].wrappedValue
    height = model.by_type('IfcWall')[0].Representation.Representations[0].Items[0].Depth
    opening = model.by_type('IfcWall')[0].HasOpenings[0].RelatedOpeningElement.Representation.Representations[0].Items[0]
    half_width = opening.SweptArea.YDim/2
    cut_height = opening.Depth
    bands = []
    for thickness in thicknesses:
        outer = radius+thickness
        before = height*span*(outer**2-radius**2)/2
        # Composite Simpson integration, 4096 intervals across the narrow strip.
        n = 4096
        dy = 2*half_width/n
        values = [math.sqrt(outer**2-(-half_width+i*dy)**2)-math.sqrt(radius**2-(-half_width+i*dy)**2) for i in range(n+1)]
        removed = cut_height*dy/3*(values[0]+values[-1]+4*sum(values[1:-1:2])+2*sum(values[2:-1:2]))
        bands.append({'before':before,'after':before-removed})
        radius=outer
    for expected, got in zip(case['bands'], bands, strict=True):
        for key in ['before','after']:
            if abs(expected[key]-got[key]) > 1e-9:
                raise AssertionError(f'source numerical integration {key}: {got[key]} != {expected[key]}')
    return bands


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path)
    args=parser.parse_args()
    try:
        import ifcopenshell
        import ifcopenshell.geom
        import numpy as np
    except ImportError as e:
        raise SystemExit(f'UNRUN: installed IfcOpenShell/numpy required: {e}')
    oracle=json.loads((ROOT/'oracles.json').read_text())
    tolerances=json.loads((ROOT/'tolerances.json').read_text())
    settings=ifcopenshell.geom.settings()
    settings.set('use-world-coords',True)
    settings.set('mesher-linear-deflection',0.00001)
    settings.set('mesher-angular-deflection',0.01)
    report={'license':'SPDX-License-Identifier: MPL-2.0','ifcopenshell':ifcopenshell.version,'linear_deflection':1e-5,'angular_deflection':0.01,'measurements':[],'passed':True,'pass_scope':'absolute analytic volume and centroid only; raw signed orientation recorded separately; no ifc-lite result','all_outward':True}
    for name,case in oracle['cases'].items():
        path=ROOT/name
        model=ifcopenshell.open(str(path))
        if name.startswith('f-a'):
            report['source_numerical_band_integrals']=source_volumes(model,case)
        for row in case.get('products',[case]):
            # Keep the shape alive: its borrowed geometry belongs to it.
            shape=ifcopenshell.geom.create_shape(settings,model.by_id(row['id']))
            v=np.asarray(shape.geometry.verts).reshape(-1,3)
            t=np.asarray(shape.geometry.faces).reshape(-1,3)
            v=v-v[0]
            tetra=np.einsum('ij,ij->i',v[t[:,0]],np.cross(v[t[:,1]],v[t[:,2]]))/6
            signed_volume=float(tetra.sum())
            volume=abs(signed_volume)
            report['all_outward'] &= signed_volume>0
            key='planar_volume_absolute'
            if name.startswith('f-a'):
                key='curved_band_mesh_volume_absolute' if 'band' in row else 'curved_total_mesh_volume_absolute'
            tol=tolerances[key]
            delta=volume-row['volume']
            passed=abs(delta)<=tol
            centroid_report=None
            if 'local_centroid' in row:
                centroid=(np.asarray(shape.geometry.verts).reshape(-1,3)[0]+((v[t[:,0]]+v[t[:,1]]+v[t[:,2]])*tetra[:,None]/4).sum(axis=0)/signed_volume)
                expected=np.asarray(row['translation'])+np.asarray(row['basis_columns']).T@(np.asarray(row['scale'])*np.asarray(row['local_centroid']))
                delta_centroid=float(np.max(np.abs(centroid-expected)))
                passed &= delta_centroid<=tolerances['position_absolute']
                centroid_report={'actual':centroid.tolist(),'expected':expected.tolist(),'max_delta':delta_centroid}
            report['passed'] &= passed
            report['measurements'].append({'file':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'id':row['id'],'volume':volume,'raw_signed_volume':signed_volume,'outward':signed_volume>0,'centroid':centroid_report,'expected':row['volume'],'delta':delta,'tolerance':tol,'triangles':len(t),'passed':passed})
    result=json.dumps(report,indent=2)+'\n'
    if args.report:
        args.report.write_text(result)
    print(result)
    raise SystemExit(0 if report['passed'] else 1)


if __name__=='__main__':
    main()
