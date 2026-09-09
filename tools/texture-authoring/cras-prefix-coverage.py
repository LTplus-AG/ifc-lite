# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Offline CRAS coverage diagnostic. Requires numpy; no network requests.
# Usage: python3 cras-prefix-coverage.py DIRECTORY_CONTAINING_128M_PREFIX
import sys
import pathlib,zlib,struct,json,numpy as np
p=pathlib.Path(sys.argv[1]);b=(p/'cras-prefix-128m.zip.part').read_bytes();h=struct.unpack_from('<4s5H3I2H',b);start=30+h[-2]+h[-1];dec=zlib.decompressobj(-15);carry=b'';idx=-2;seen=set();seenxy=set();reports=[];all_samples=[];last=0
for stop in [16*1024*1024,32*1024*1024,64*1024*1024,128*1024*1024]:
 lo=np.full(3,np.inf);hi=-lo;block=[];cells=set();xy=set();rows=0
 for pos in range(start,stop,262144):
  raw=carry+dec.decompress(b[pos:min(pos+262144,stop)]);raw,carry=raw.rsplit(b'\n',1);lines=raw.splitlines()
  if idx<0:lines=lines[-idx:];idx=0
  if not lines:continue
  a=np.loadtxt(lines);lo=np.minimum(lo,a[:,:3].min(0));hi=np.maximum(hi,a[:,:3].max(0));q=np.floor(a[:,:3]/.25).astype(np.int32)
  cells.update(map(tuple,np.unique(q,axis=0)));xy.update(map(tuple,np.unique(q[:,:2],axis=0)))
  take=a[(-idx)%64::64,:3];block.append(take);all_samples.append(take);rows+=len(a);idx+=len(a)
 a=np.concatenate(block);c=np.concatenate(all_samples)
 reports.append({'compressed_interval':[last,stop-1],'complete_rows_in_block':rows,'complete_rows_cumulative':idx,'block_bounds':[lo.tolist(),hi.tolist()],'sample_stride':64,'block_xyz_quantiles_05_50_95':np.quantile(a,[.05,.5,.95],axis=0).tolist(),'cumulative_xyz_quantiles_05_50_95':np.quantile(c,[.05,.5,.95],axis=0).tolist(),'block_occupied_25cm_voxels':len(cells),'new_25cm_voxels':len(cells-seen),'block_occupied_25cm_xy_cells':len(xy),'new_25cm_xy_cells':len(xy-seenxy),'block_sample_z_bands':{'below_minus1':int((a[:,2]<-1).sum()),'minus1_to0':int(((a[:,2]>=-1)&(a[:,2]<0)).sum()),'zero_to1':int(((a[:,2]>=0)&(a[:,2]<1)).sum()),'above1':int((a[:,2]>=1).sum())}})
 seen.update(cells);seenxy.update(xy);start=stop;last=stop
out={'voxel_size_metres':.25,'registration':None,'interpretation':'Density/coverage diagnostics in source coordinates; quantiles use every64th source row, occupied cells use every examined point. Zbands are numeric, not semantic wall/floor labels.','blocks':reports};(p/'cras-prefix-coverage.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
