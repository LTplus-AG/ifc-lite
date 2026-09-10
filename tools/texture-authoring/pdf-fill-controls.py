#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Original CC0 fill-only PDF controls; requires reportlab 4.4.3.

Usage: python3 tools/texture-authoring/pdf-fill-controls.py /tmp/pdf-fill-controls.pdf
Artwork is original CC0; generator code remains MPL-2.0. No text or raster paint.
"""
import sys
from reportlab.pdfgen import canvas


def generate(path):
    c = canvas.Canvas(path, pagesize=(240, 240), invariant=1, pageCompression=0)
    c.setTitle("Original CC0 PDF fill controls")
    # Outer red square extends beyond the implicit page clip. Same-winding
    # inner square is a hole only under EvenOdd. Later blue paint must occlude
    # red; native output must not rely on coplanar draw order or Z offsets.
    p = c.beginPath()
    p.rect(0, 0, 300, 300)
    p.rect(60, 60, 30, 30)
    c.setFillColorRGB(1, 0, 0)
    c.drawPath(p, stroke=0, fill=1, fillMode=0)
    c.setFillColorRGB(0, 0, 1)
    c.rect(120, 120, 60, 60, stroke=0, fill=1)
    c.showPage()
    # Same-winding NonZero control: the inner square contributes filled paint.
    p = c.beginPath()
    p.rect(0, 0, 300, 300)
    p.rect(60, 60, 30, 30)
    c.setFillColorRGB(1, 0, 0)
    c.drawPath(p, stroke=0, fill=1, fillMode=1)
    c.setFillColorRGB(0, 0, 1)
    c.rect(120, 120, 60, 60, stroke=0, fill=1)
    c.showPage()
    c.save()


if __name__ == "__main__":
    generate(sys.argv[1])
