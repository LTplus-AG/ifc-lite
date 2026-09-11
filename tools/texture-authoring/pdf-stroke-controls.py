# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Original CC0 solid straight-stroke controls, ReportLab 4.4.3."""
from pathlib import Path
import sys
from reportlab.pdfgen import canvas
out=Path(sys.argv[1]);out.parent.mkdir(parents=True,exist_ok=True)
c=canvas.Canvas(str(out),pagesize=(240,240),invariant=1,pageCompression=0)
c.setTitle('IFClite straight stroke controls — original CC0 artwork')
# Every edge is axis-aligned/integer except the explicit affine page.
for cap,join,limit in [(0,0,10),(2,2,10),(0,0,1)]:
 c.setLineWidth(12);c.setLineCap(cap);c.setLineJoin(join);c.setMiterLimit(limit)
 c.setStrokeColorRGB(0,0.6,0.2)
 p=c.beginPath();p.moveTo(60,60);p.lineTo(150,60);p.lineTo(150,150)
 c.drawPath(p,stroke=1,fill=0);c.showPage()
c.setLineWidth(12);c.setLineJoin(0);c.setStrokeColorRGB(0,0.6,0.2);c.setFillColorRGB(0.8,0.1,0.2)
c.rect(60,60,120,120,stroke=1,fill=1);c.showPage()
c.saveState();c.transform(1,.2,.35,.8,10,10)
c.setLineWidth(12);c.setLineCap(2);c.setLineJoin(0);c.setStrokeColorRGB(0,0.6,0.2)
p=c.beginPath();p.moveTo(45,45);p.lineTo(120,45);p.lineTo(120,120)
c.drawPath(p,stroke=1,fill=0);c.restoreState();c.showPage()
c.save()
