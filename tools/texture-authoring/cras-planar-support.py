# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Offline CRAS source-neighborhood diagnostic for #4381; not registration.

Requires NumPy, SciPy and Matplotlib. Input: pinned cras-expanded-sample.tsv in DIRECTORY.
Writes small report and exact original-row lists into DIRECTORY. No network.
The fixed seed makes hypotheses reproducible within the recorded environment;
floating-point neighborhood ties can differ across library/platform versions.
"""
import json, hashlib, sys
import scipy
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
directory = Path(sys.argv[1])
p = directory / 'cras-expanded-sample.tsv'
expected = 'bafe1db01f2bc9fc16e117c02891bccb9e5bcea93cc42ab1aa45d8dc53b789de'
if hashlib.sha256(p.read_bytes()).hexdigest() != expected:
    raise ValueError('Expected the pinned 128 MiB CRAS sample; input identity differs')
a=np.loadtxt(p,skiprows=1); xyz=a[:,1:4]
# Deterministic first source point per 3 cm voxel, retaining original rows.
_, ix=np.unique(np.floor(xyz/.03).astype(np.int64),axis=0,return_index=True)
ix=np.sort(ix); x=xyz[ix]; tree=cKDTree(x)
d,nn=tree.query(x,k=20); near=x[nn]; cov=np.einsum('nki,nkj->nij',near-near.mean(axis=1)[:,None,:],near-near.mean(axis=1)[:,None,:])/20
w,v=np.linalg.eigh(cov); normal=v[:,:,0]
valid=(d[:,-1]<=.2)&(w[:,0]/np.maximum(w.sum(axis=1),1e-20)<.008)&(w[:,1]>.00005)
left=np.where(valid)[0]; rng=np.random.default_rng(4381); planes=[]
for iteration in range(16):
 if len(left)<80:break
 best=np.array([],dtype=int)
 for c in rng.choice(left,min(600,len(left)),replace=False):
  n=normal[c]; dist=np.abs((x[left]-x[c])@n)
  cand=left[(dist<.02)&(np.abs(normal[left]@n)>.985)]
  if len(cand)>len(best):best=cand
 if len(best)<80:break
 # Split coplanar but disconnected patches; do not bridge unseen surfaces.
 pairs=cKDTree(x[best]).query_pairs(.22,output_type='ndarray')
 g=coo_matrix((np.ones(len(pairs)),(pairs[:,0],pairs[:,1])),shape=(len(best),len(best)))
 _,labels=connected_components(g,directed=False)
 for label in np.unique(labels):
  sel=best[labels==label]
  if len(sel)<60:continue
  q=x[sel]; centre=q.mean(axis=0); _,s,vt=np.linalg.svd(q-centre,full_matrices=False); n=vt[-1]
  if n[np.argmax(abs(n))]<0:n=-n
  residual=(q-centre)@n
  rows=a[ix[sel],0].astype(np.int64)
  feature={'id':len(planes),'point_count':len(sel),'centre':centre.tolist(),'normal_unoriented':n.tolist(),'offset':float(n@centre),'bounds':[q.min(axis=0).tolist(),q.max(axis=0).tolist()],'principal_spans':np.ptp((q-centre)@vt.T,axis=0).tolist(),'plane_rms_m':float(np.sqrt(np.mean(residual**2))),'source_rows_sha256':hashlib.sha256(rows.astype('<i8').tobytes()).hexdigest(),'source_row_examples':rows[np.linspace(0,len(rows)-1,min(8,len(rows)),dtype=int)].tolist()}
  planes.append(feature)
  np.savetxt(directory / ('cras-plane-%02d-rows.txt' % feature['id']), rows, fmt='%d')
 left=left[~np.isin(left,best)]
r={'input_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'input_points':len(a),'voxel_points':len(x),'planar_points':int(valid.sum()),'parameters':{'voxel_m':.03,'neighbors':20,'max_neighbor_radius_m':.2,'planarity_ratio':.008,'minimum_second_eigenvalue_m2':.00005,'ransac_trials_per_round':600,'rounds':16,'seed':4381,'plane_distance_m':.02,'normal_dot_min':.985,'component_link_m':.22,'minimum_component_points':60},'status':'Unoriented source-space plane candidates only; no semantic classification, IFC correspondence, registration or held-out accuracy','planes':planes}
# Conditioning diagnostic on the four broad horizontal patches plus the long
# vertical patch. This is NOT a scan-to-IFC fit: no target coordinates are used.
normals = np.array([plane['normal_unoriented'] for plane in planes[:5]])
_, singular_values, directions = np.linalg.svd(normals, full_matrices=False)
weak_direction = directions[-1]
deltas = normals @ weak_direction  # 1 metre translation along weakest direction
r['environment'] = {'numpy': np.__version__, 'scipy': scipy.__version__}
r['translation_observability'] = {
    'plane_ids': [0, 1, 2, 3, 4],
    'selection_reason': 'Four near-horizontal components and one long near-vertical component; exploratory selection after extraction, not frozen acceptance landmarks',
    'normal_matrix_singular_values': singular_values.tolist(),
    'condition_number': float(singular_values[0] / singular_values[-1]),
    'unit_weak_translation_direction': weak_direction.tolist(),
    'one_metre_shift_signed_plane_distance_deltas_m': deltas.tolist(),
    'one_metre_shift_max_distance_delta_m': float(np.max(abs(deltas))),
    'interpretation': 'Almost unobservable translation along these surfaces; this algebra does not establish any IFC correspondence or registration transform',
}
(directory / 'cras-planar-support.json').write_text(json.dumps(r, indent=2) + '\n')
print('counts',len(x),int(valid.sum()),'planes',len(planes))
for z in planes:print(z['id'],z['point_count'],np.round(z['centre'],3),np.round(z['normal_unoriented'],3),np.round(z['principal_spans'],3),round(z['plane_rms_m'],4))

# Visual audit of source support: labels are candidate IDs, never IFC owners.
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 2, figsize=(12, 9), constrained_layout=True)
for axis, horizontal, vertical, xlabel, ylabel in [
    (axes[0], 0, 1, 'X source metres', 'Y source metres'),
    (axes[1], 1, 2, 'Y source metres', 'Z source metres'),
]:
    axis.scatter(x[:, horizontal], x[:, vertical], s=.4, c='lightgray')
    for feature in planes:
        rows = np.loadtxt(directory / ('cras-plane-%02d-rows.txt' % feature['id']), dtype=np.int64)
        points = xyz[np.searchsorted(a[:, 0], rows)]
        color = plt.get_cmap('tab10')(feature['id'] % 10)
        axis.scatter(points[:, horizontal], points[:, vertical], s=1.5, color=color)
        axis.annotate(str(feature['id']), (feature['centre'][horizontal], feature['centre'][vertical]),
                      fontsize=8, color='black', bbox={'facecolor': 'white', 'alpha': .7, 'pad': 1, 'edgecolor': 'none'})
    axis.set(xlabel=xlabel, ylabel=ylabel)
    axis.set_aspect('equal')
    axis.grid(alpha=.2)
fig.suptitle('CRAS source plane candidates: neighborhood IDs only, no IFC registration')
fig.savefig(directory / 'cras-planar-support.png', dpi=150)
plt.close(fig)
