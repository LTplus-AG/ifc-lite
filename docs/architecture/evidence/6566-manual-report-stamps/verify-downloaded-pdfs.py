# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
import hashlib
import json
import pathlib
import sys
import fitz

root = pathlib.Path(sys.argv[1])
observations = []
for name in ('1-shown', '1-hidden', '2-shown', '2-hidden', '2-imported-hidden', '2-reshown'):
    path = root / (name + '.pdf')
    with fitz.open(path) as doc:
        text = '\n'.join(page.get_text() for page in doc)
        spans = [dict(text=span['text'], bbox=span['bbox']) for page in doc for block in page.get_text('dict')['blocks'] if 'lines' in block for line in block['lines'] for span in line['spans']]
        stamp = any('Recorded:' in span['text'] for span in spans)
        scope = any('Models:' in span['text'] for span in spans)
        expected = name.endswith('-shown') or name.endswith('-reshown')
        assert stamp == expected, (name, 'recorded stamp', text)
        assert scope == expected, (name, 'model scope', text)
        assert 'Uploaded on time' in text and 'Naming convention' in text, (name, 'lost answers', text)
        comment = 'Reviewed and approved' if name in ('2-imported-hidden', '2-reshown') else 'Review retained prefix'
        assert comment in text, (name, 'lost comment', text)
        first_check_y = next(span['bbox'][1] for span in spans if 'Uploaded on time' in span['text'])
        observations.append(dict(file=path.name, bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), pages=len(doc), stamp=stamp, scope=scope, text=text, firstCheckY=first_check_y))
for count in (1, 2):
    shown, hidden = (next(row for row in observations if row['file'] == f'{count}-{flag}.pdf') for flag in ('shown', 'hidden'))
    shown_y, hidden_y = shown['firstCheckY'], hidden['firstCheckY']
    assert hidden_y < shown_y, (count, 'hidden rows leave a blank gap', shown_y, hidden_y)
    hidden['firstCheckMovesUpPoints'] = shown_y - hidden_y
(root / 'downloaded-pdf-observations.json').write_text(json.dumps(dict(engine='PyMuPDF independently opened completed browser downloads; no PDF seams', observations=observations), indent=2) + '\n')
print(json.dumps([dict(file=row['file'], pages=row['pages'], stamp=row['stamp'], scope=row['scope'], firstCheckMovesUpPoints=row.get('firstCheckMovesUpPoints')) for row in observations]))
