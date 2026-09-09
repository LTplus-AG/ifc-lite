# /// script
# requires-python = ">=3.10"
# dependencies = ["reportlab==4.4.3", "pypdf==6.0.0"]
# ///
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Generate original CC0 vector controls for #4406. Usage: uv run <script> out.pdf.

The output drawing content is dedicated to CC0; the generator is MPL-2.0.
No text on page one (ReportLab may emit unused font setup operators).
"""
import io
import sys
from pathlib import Path

from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter
from pypdf.generic import FloatObject, NameObject, RectangleObject

stream = io.BytesIO()
c = canvas.Canvas(stream, pagesize=(360, 240), invariant=1, pageCompression=0)
c.setTitle("IFClite original vector controls - CC0")
c.setLineWidth(2)
c.setStrokeColorRGB(0, 0, 1)
c.line(20, 20, 92, 20)  # Exactly 72 native units; paper span doubles with UserUnit.
c.setFillColorRGB(1, 0, 0)
c.rect(20, 50, 72, 36, fill=1, stroke=0)
p = c.beginPath()
p.moveTo(120, 20)
p.curveTo(120, 100, 220, 100, 220, 20)
c.drawPath(p, stroke=1, fill=0)
c.saveState()
c.translate(180, 140)
c.rotate(30)
c.scale(2, 0.5)
c.setDash(6, 3)
c.line(0, 0, 40, 0)
c.restoreState()
c.showPage()
# A supported-looking path lives under clipping and transparency; dropping the
# surrounding operators produces wrong pixels even if the path itself parses.
c.saveState()
p = c.beginPath()
p.circle(100, 100, 40)
c.clipPath(p, stroke=0, fill=0)
c.setFillColorRGB(0, 0, 1)
c.rect(20, 40, 160, 120, fill=1, stroke=0)
c.setFillAlpha(0.4)
c.setFillColorRGB(1, 0, 0)
c.rect(80, 40, 160, 120, fill=1, stroke=0)
c.restoreState()
c.setFillColorRGB(0, 0, 0)
c.setFont("Helvetica", 14)
c.drawString(20, 190, "Text, clip and alpha must survive")
c.showPage()
c.save()
reader = PdfReader(stream)
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
first = writer.pages[0]
first[NameObject("/CropBox")] = RectangleObject([10, 10, 340, 220])
first[NameObject("/UserUnit")] = FloatObject(2)
first.rotate(90)
writer.add_metadata({"/Title": "IFClite original vector controls - CC0"})
with Path(sys.argv[1]).open("wb") as output:
    writer.write(output)
