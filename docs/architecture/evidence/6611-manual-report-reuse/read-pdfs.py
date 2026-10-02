# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independently inspect completed browser downloads; not a PDF generator."""
import hashlib, json, pathlib, sys
import pymupdf
folder = pathlib.Path(sys.argv[1])
results = []
for count in (1, 2):
    for label in ('original', 'edited'):
        path = folder / f'{count}-{label}.pdf'
        raw = path.read_bytes()
        with pymupdf.open(path) as document:
            text = '\n'.join(page.get_text() for page in document)
            assert len(document) == 1
            assert 'Model: building-architecture.ifc' in text
            assert 'Check the recorded delivery.' in text
            assert 'Comment: Unanswered note must survive' in text
            assert 'NOT CHECKED\nFollow-up note' in text
            if label == 'original':
                assert 'Pass 1 · Warning 1 · Fail 0 · Not checked 1' in text
                assert 'WARNING\nNaming convention' in text
                assert 'Comment: Recorded prefix needs review' in text
                assert 'Edited current copy' not in text
            else:
                assert 'Pass 2 · Warning 0 · Fail 0 · Not checked 1' in text
                assert 'PASS\nNaming convention' in text
                assert 'Comment: Edited current copy' in text
                assert 'Recorded prefix needs review' not in text
            results.append({'file': path.name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'pages': len(document), 'text': text})
(folder / 'pdf-inspection.json').write_text(json.dumps({'reader': f'PyMuPDF {pymupdf.VersionBind}', 'results': results}, indent=2) + '\n')
print(json.dumps({'pdfs': len(results), 'allAssertionsPassed': True}))
