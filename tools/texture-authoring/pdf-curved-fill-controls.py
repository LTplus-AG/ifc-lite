# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Original CC0 curved PDF artwork; requires ReportLab 4.4.3."""
from pathlib import Path
import sys
from reportlab.pdfgen import canvas

output = Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)
c = canvas.Canvas(str(output), pagesize=(240, 240), invariant=1, pageCompression=0)
c.setTitle("IFClite controlled curved fills — original CC0 artwork")
c.setFillColorRGB(0.8, 0.1, 0.2)
c.ellipse(60, 75, 180, 165, stroke=0, fill=1)
c.showPage()
c.setFillColorRGB(0.1, 0.3, 0.8)
p = c.beginPath()
p.ellipse(50, 50, 140, 140)
p.ellipse(90, 90, 60, 60)
c.drawPath(p, stroke=0, fill=1, fillMode=0)
c.showPage()
c.saveState()
c.transform(1, 0.2, 0.35, 0.8, 20, 10)
c.setFillColorRGB(0.1, 0.7, 0.3)
c.ellipse(50, 50, 130, 130, stroke=0, fill=1)
c.restoreState()
c.showPage()
c.save()
