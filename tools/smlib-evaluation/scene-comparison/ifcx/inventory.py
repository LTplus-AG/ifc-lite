# SPDX-License-Identifier: MPL-2.0
"""Inventory only manifest-verified scene inputs; no format loader/geometry path."""
from pathlib import Path
import hashlib,json,re,subprocess,zipfile

root=Path(__file__).resolve().parents[4]
manifest=json.loads((root/'tests/models/manifest.json').read_text())
selected=json.loads((Path('/tmp/ifclite-scene-ifcx-candidate')/'summary.json').read_text())['metadata']
paths={row['name'] for row in selected}
paths.update('buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-'+kind+'.ifc'
             for kind in ['blob-texture','image-texture','pixel-texture','individual-colors'])
paths.add('textures/ifc-hbim-convento-textures.ifczip')
def schema(data):
    match=re.search(r'FILE_SCHEMA\s*\((.*?)\)\s*;',data.decode('latin1'),re.S|re.I)
    return match.group(1) if match else None

def image_urls(data):
    urls=[]
    for content in re.findall(r'IFCIMAGETEXTURE\s*\((.*?)\)\s*;',data.decode('latin1'),re.S|re.I):
        strings=re.findall(r"'((?:''|[^'])*)'",content)
        urls.append(strings[-1] if strings else None)
    return urls

rows=[]
for entry in manifest['files']:
    if entry['path'] not in paths:continue
    path=root/'tests/models'/entry['path'];data=path.read_bytes()
    observed=hashlib.sha256(data).hexdigest();assert observed==entry['sha256']
    row={'path':entry['path'],'bytes':len(data),'sha256':observed,
         'download':manifest['base_url'].rstrip('/')+'/'+observed,
         'upstream_source':'not recorded in fixture manifest',
         'redistribution_license':'not recorded in fixture manifest'}
    if path.suffix=='.ifcx':
        source=json.loads(data);row.update(header=source['header'],imports=source.get('imports',[]),schemas=list(source.get('schemas',{})))
    elif path.suffix=='.ifc':
        row.update(FILE_SCHEMA=schema(data),image_references=[{'UrlReference':url,'sibling_exists':(path.parent/url).exists() if url else False} for url in image_urls(data)],
                   source_blob_texture_records=data.upper().count(b'IFCBLOBTEXTURE('),source_pixel_texture_records=data.upper().count(b'IFCPIXELTEXTURE('))
    else:
        target=Path('/tmp/ifclite-scene-ifcx-archive');target.mkdir(exist_ok=True);assets=[]
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                dest=target/info.filename;assert dest.resolve().is_relative_to(target.resolve())
                blob=archive.read(info);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(blob)
                record={'member':info.filename,'bytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}
                if info.filename.lower().endswith('.ifc'):
                    record.update(FILE_SCHEMA=schema(blob),image_references=[{'UrlReference':url,'resolved_archive_member':url if url in archive.namelist() else None} for url in image_urls(blob)])
                else:record['file_description']=subprocess.check_output(['file','-b',str(dest)],text=True).strip()
                assets.append(record)
        row['members']=assets
    rows.append(row)
assert len(rows)==12
output=Path(__file__).with_name('fixtures.json')
output.write_text(json.dumps({'scope':'manifest-hash-verified bytes and observed declarations/assets; no license assertion','fixtures':rows},indent=2)+'\n')
print(f'Inventoried {len(rows)} verified fixtures into {output}')
