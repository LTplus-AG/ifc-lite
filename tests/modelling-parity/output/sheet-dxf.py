# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Independent #9296 section DXF oracle; model metres, paper scale 1:50."""
import io
import json
import math
import sys

import ezdxf


def judge(text):
    doc = ezdxf.read(io.StringIO(text))
    audit = doc.audit()
    entities = list(doc.modelspace())
    layers = {layer.dxf.name for layer in doc.layers}
    cuts = []
    for entity in entities:
        if entity.dxftype() != 'POLYLINE' or entity.dxf.layer != 'IFC-FILL':
            continue
        points = [vertex.dxf.location for vertex in entity.vertices]
        if not points:
            continue
        xs, ys = [p.x for p in points], [p.y for p in points]
        if abs(max(xs)-min(xs)-0.2) < 0.005 and abs(max(ys)-min(ys)-3) < 0.005:
            cuts.append((min(xs), max(xs)))
    span = max(p[1] for p in cuts)-min(p[0] for p in cuts) if len(cuts) >= 2 else None
    dimensions = [e for e in entities if e.dxf.layer == 'IFC-DIMENSIONS']
    labels = [e.dxf.text for e in dimensions if e.dxftype() == 'TEXT']
    lines = [e for e in dimensions if e.dxftype() == 'LINE']
    length_ok = any(
        span is not None
        and abs((e.dxf.end-e.dxf.start).magnitude-5.2) < .01
        and abs(min(e.dxf.start.x,e.dxf.end.x)-min(p[0] for p in cuts)) < .005
        and abs(max(e.dxf.start.x,e.dxf.end.x)-max(p[1] for p in cuts)) < .005
        for e in lines
    )
    values = []
    for label in labels:
        try:
            values.append(float(label.removesuffix(' m')))
        except ValueError:
            continue
    points = []
    for entity in entities:
        if entity.dxftype() == 'LINE':
            points.extend([entity.dxf.start, entity.dxf.end])
        elif entity.dxftype() == 'TEXT':
            points.append(entity.dxf.insert)
        elif entity.dxftype() == 'POLYLINE':
            points.extend(vertex.dxf.location for vertex in entity.vertices)
    checks = [
        ('ezdxf parses without audit errors or repairs', not audit.errors and not audit.fixes),
        ('R12 version and explicit metre units', doc.dxfversion == 'AC1009' and '$ACADVER' in text and 'units: metres' in text),
        ('named wall and dimension layers', {'IFC-CUT', 'IFC-FILL', 'IFC-DIMENSIONS'} <= layers),
        ('two 200 mm by 3 m cut walls span 104 mm at 1:50', span is not None and abs(span*1000/50-104) <= .5),
        ('5.2 m outer-span dimension line and matching dimension TEXT', length_ok and any(abs(v-5.2) < .01 for v in values)),
        ('finite coordinates', bool(points) and all(math.isfinite(v) for p in points for v in p)),
    ]
    return {'reader': 'ezdxf', 'version': ezdxf.__version__, 'wallSpanMetres': span,
            'paperSpanMm': span*20 if span is not None else None, 'dimensionText': labels,
            'entities': len(entities), 'checks': [{'name': name, 'ok': bool(ok)} for name, ok in checks]}


if __name__ == '__main__':
    try:
        result = judge(sys.stdin.buffer.read().decode('cp1252'))
    except Exception as error:
        result = {'reader': 'ezdxf', 'version': ezdxf.__version__, 'checks': [{'name': 'DXF parses', 'ok': False, 'detail': str(error)}]}
    print(json.dumps(result))
