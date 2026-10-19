# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Compare emitted public JSON/CSV only. No IFC parser, budget math or decoder."""
import csv,hashlib,io,json,sys
csv.field_size_limit(64*1024**2)
MARKER="(truncated: nested properties over the walk budget)"
F_SHA="92a974b8fddd650169101d999d3acb2ed120243559a60a8a28ae8cb2a157efeb"
def pin(v):return {"bytes":len(v.encode()),"sha256":hashlib.sha256(v.encode()).hexdigest()}
def f(v):assert len(v.encode())==532946 and pin(v)['sha256']==F_SHA
# Row debug is an emitted product witness; discard only the separately structured
# property-set field when comparing otherwise-unmodified metadata/quantities/attributes.
def row_metadata(row):
 s=row['full_row_debug'];left,sep,right=s.partition(', property_sets: ');assert sep
 _,sep,right=right.partition(', quantity_sets: ');assert sep
 return left+', quantity_sets: '+right
def row_entries(doc):
 for row in doc['rows']:
  for si,s in enumerate(row['property_sets']):
   for pi,p in enumerate(s['properties']):yield row['express_id'],si,pi,s['name'],p

def python_entries(doc):
 for id,row in doc['entities'].items():
  for si,s in enumerate(row['property_sets']):
   for pi,p in enumerate(s['properties']):yield int(id),si,pi,s['name'],p

def flat_csv(doc):return list(csv.DictReader(io.StringIO(doc['csv'],newline='')))
def entries(api,doc):
 if api in ['build','stream']:return list(row_entries(doc))
 if api=='entity_data':return list(python_entries(doc))
 if api=='csv':
  return [(int(r['entityId']),None,None,r['psetName'],{'name':r['propName'],'value':r['value'],'value_type':r['type']}) for r in flat_csv(doc)]
 raise AssertionError(api)
def canonical_members(server):
 out={}
 for s in server['property_sets']:
  for p in s['properties']:out.setdefault((s['pset_name'],p['property_name']),set()).add(p['property_value'])
 return out

def validate(name,docs):
 base={a:docs[a,'base'] for a in ['stream','build','csv','entity_data','server']};raw={a:docs[a,'raw'] for a in base}
 normative=name!='AC20-FZK-Haus.ifc';deltas=[];checks={};canonical={}
 for side,ds in [('base',base),('raw',raw)]:
  assert ds['stream']==ds['build'],(name,side,'stream/build full row and units mismatch')
  assert ds['server']['refused'] is None,(name,side,'server refused')
  cm=canonical_members(ds['server']);canonical[side]=cm
  # Real CSV columns and order are compared to the actual public build output.
  rows=entries('build',ds['build']);cells=flat_csv(ds['csv']);assert len(rows)==len(cells),(name,side,'CSV row count')
  for (id,si,pi,s,p),c in zip(rows,cells):
   assert (c['entityId'],c['psetName'],c['propName'],c['value'],c['type'])==(str(id),s,p['name'],p['value'],p['value_type']),(name,side,'CSV/build projection',id,s,p['name'])
  for c in cells:
   pyrow=ds['entity_data']['entities'][c['entityId']]
   assert (c['globalId'],c['entityName'],c['entityType'])==(pyrow['global_id'] or '',pyrow['name'] or '',pyrow['ifc_type']),(name,side,'CSV/Python metadata',c['entityId'])
  for *_,prop in python_entries(ds['entity_data']):assert set(prop)=={'name','value','value_type'}
  # Python enables type inheritance/attributes; match actual canonical members,
  # not own-only Rust row counts. BASE normative drift is the retained defect.
  if side=='raw' or not normative:
   for api in ['stream','build','csv','entity_data']:
    es=entries(api,ds[api])
    for id,si,pi,s,p in es:assert p['value'] in cm.get((s,p['name']),set()),(name,side,api,'canonical member mismatch',id,s,p['name'],pin(p['value']))
    checks[side+'/'+api]={'propertiesComparedToActualCanonicalServer':len(es)}
  if normative:
   sets=ds['server']['property_sets'];shared=next(s for s in sets if s['pset_name']=='Pset_Shared');assert len(shared['properties'])==1;f(shared['properties'][0]['property_value'])
   if name=='02-opposed-products.ifc':
    assert [s['pset_id'] for s in sets]==[30,31]
    assert sets[1]['properties'][0]['property_value']==MARKER
   for api in ['stream','build','csv','entity_data']:
    es=entries(api,ds[api])
    if api!='csv':
     ids=[r['express_id'] for r in ds[api]['rows']] if api in ['stream','build'] else list(map(int,ds[api]['entities']))
     assert ids==list(range(100,300)),(name,api,side,'row order')
    assert len(es)==(200 if name=='shared-set.ifc' else 2)
    for id,si,pi,s,p in es:
     assert p['name']=='Wide'
     if api in ['stream','build']:assert p['kind']=='Text'
     if side=='raw':
      if s=='Pset_Shared':f(p['value'])
      else:assert name=='02-opposed-products.ifc' and s=='Pset_Second' and p['value']==MARKER
     else:
      assert p['value']==MARKER or pin(p['value'])=={'bytes':532946,'sha256':F_SHA},(name,api,'BASE value outside known F/M defect',id,s,pin(p['value']))
    if name=='02-opposed-products.ifc':assert [(r[0],r[3]) for r in es]==[(100,'Pset_Second'),(101,'Pset_Shared')]
 if not normative:
  for api in base:assert base[api]==raw[api],(name,api,'unexplained Haus BASE/raw output drift')
 else:
  assert base['server']==raw['server'],(name,'canonical server drift')
  assert base['build']['units_debug']==raw['build']['units_debug'],(name,'units drift')
  for a,b in zip(base['build']['rows'],raw['build']['rows']):
   assert [(s['name'],len(s['properties'])) for s in a['property_sets']]==[(s['name'],len(s['properties'])) for s in b['property_sets']]
   assert a['express_id']==b['express_id'] and row_metadata(a)==row_metadata(b),(name,'non-property row metadata drift',a['express_id'])
  bp=base['entity_data'];rp=raw['entity_data'];assert {k:v for k,v in bp.items() if k!='entities'}=={k:v for k,v in rp.items() if k!='entities'}
  assert list(bp['entities'])==list(rp['entities'])
  for id in bp['entities']:assert [(s['name'],len(s['properties'])) for s in bp['entities'][id]['property_sets']]==[(s['name'],len(s['properties'])) for s in rp['entities'][id]['property_sets']]
  for a,b in zip(flat_csv(base['csv']),flat_csv(raw['csv'])):assert {k:v for k,v in a.items() if k!='value'}=={k:v for k,v in b.items() if k!='value'}
  for id in bp['entities']:assert {k:v for k,v in bp['entities'][id].items() if k!='property_sets'}=={k:v for k,v in rp['entities'][id].items() if k!='property_sets'},(name,'Python metadata/quantity/attribute drift',id)
  for api in ['stream','build','csv','entity_data']:
   a=entries(api,base[api]);b=entries(api,raw[api]);assert len(a)==len(b)
   for x,y in zip(a,b):
    assert x[:4]==y[:4] and {k:v for k,v in x[4].items() if k!='value'}=={k:v for k,v in y[4].items() if k!='value'},(name,api,'property shape/order/type drift',x[:4],y[:4])
    if x[4]['value']!=y[4]['value']:deltas.append({'api':api,'entityId':x[0],'setPosition':x[1],'propertyPosition':x[2],'setName':x[3],'propertyName':x[4]['name'],'base':pin(x[4]['value']),'raw':pin(y[4]['value'])})
  assert deltas,(name,'expected BASE defect differences absent')
 return {'input':name,'status':'PASS','canonicalMemberChecks':checks,'serverSets':{side:len(ds['server']['property_sets']) for side,ds in [('base',base),('raw',raw)]},'rows':{side:{'Rust':len(ds['build']['rows']),'Python':len(ds['entity_data']['entities']),'CSVproperties':len(flat_csv(ds['csv']))} for side,ds in [('base',base),('raw',raw)]},'intendedBaseDefectDifferences':deltas,'allOtherComparedFieldsEqual':True,'HausEntireOutputsEqual':not normative,'canonicalScope':'Actual server set-name/member-value membership; public row witness omits source set IDs and server witness omits relationships, so no invented source-ID association proof','legitimateCuts':'shared-set exact normative F retained; vector cuts1 policy, APIs do not expose a cut counter'}
