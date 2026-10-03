# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fitz, hashlib, json
from pathlib import Path
path = Path(__file__).parent / 'eleven-pages.pdf'
doc = fitz.open(path)
assert len(doc) == 11
pages=[]
for index,page in enumerate(doc):
 spans=[span for block in page.get_text('dict')['blocks'] if 'lines' in block for line in block['lines'] for span in line['spans']]
 def find(text):
  result=[s for s in spans if s['text']==text]
  assert result, f'Missing {text} on page {index+1}'
  return result
 heading=find('Shared paper heading')[0]
 footer=find('Shared paper footer')[0]
 body=find(f'Real SketchUp IFC paper evidence - page {index+1}')[0]
 counters=find(f'Page {index+1} / 11')
 dates=find('2026-10-03')
 assert len(counters)==2 and len(dates)==2
 assert abs(heading['size']-22)<.001 and abs(footer['size']-12)<.001
 assert 'Times' in heading['font'] and 'Courier' in footer['font']
 assert heading['color']==0x003366 and footer['color']==0x333333
 assert heading['bbox'][3]<body['bbox'][1] and body['bbox'][3]<footer['bbox'][1]
 images=page.get_images(full=True)
 rects=[list(rect) for image in images for rect in page.get_image_rects(image[0])]
 # The same underlying bitmap can be listed once with two placements.
 unique_rects={tuple(rect) for rect in rects}
 assert len(unique_rects)==2, (index,unique_rects)
 pages.append({'page':index+1,'heading':heading,'footer':footer,'body':body,'counters':counters,'dates':dates,'imageRects':list(unique_rects)})
 if index in [0,10]: page.get_pixmap(matrix=fitz.Matrix(1.5,1.5)).save(path.parent/f'independent-page-{index+1}.png')
receipt={'reader':fitz.__doc__,'pages':pages,'pdfSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'pdfBytes':path.stat().st_size}
(path.parent/'independent-pdf.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps({'pages':len(doc),'checks':'headings,footer,font,size,ink,date,counter,logo,body bounds on every page','pdfSha256':receipt['pdfSha256']}))
