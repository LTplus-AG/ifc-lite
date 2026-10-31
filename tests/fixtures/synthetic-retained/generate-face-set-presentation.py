# SPDX-License-Identifier: MPL-2.0
"""SYNTHETIC qualification M11-T (face-set palettes and UVs), #8291. No authoring-tool provenance.

Four boxes, 2 x 1 x 3 m, each its own IfcTriangulatedFaceSet with twelve triangles authored in a
deliberately inward winding, so the closed shell flips and a UV reader that ignores the flip mirrors.
palette / texture      uncut.
palette-cut / texture-cut   the same bodies with a 0.5 x 2 x 2 opening through the x=1 band.
UVs are non-periodic and TexCoordIndex permutes CoordIndex, so ignoring the index map is observable.
"""
import json, pathlib, sys

HEADER = """ISO-10303-21;
/* SPDX-License-Identifier: MPL-2.0 */
HEADER;
FILE_DESCRIPTION(('SYNTHETIC; issue 8291; not authoring-tool evidence'),'2;1');
FILE_NAME('synthetic.ifc','2026-10-31T00:00:00',('ifc-lite'),(''),'deterministic synthetic generator','ifc-lite','MPL-2.0');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
"""
POINTS = "((0.,0.,0.),(2.,0.,0.),(2.,1.,0.),(0.,1.,0.),(0.,0.,3.),(2.,0.,3.),(2.,1.,3.),(0.,1.,3.))"
# Outward box faces with every triangle's corners 2 and 3 swapped: a consistently inward shell.
OUTWARD = [(1,4,3),(5,6,7),(1,2,6),(2,3,7),(3,4,8),(4,1,5),(1,3,2),(5,7,8),(1,6,5),(2,7,6),(3,8,7),(4,5,8)]
TRIANGLES = [(a, c, b) for a, b, c in OUTWARD]
COLOURS = "((1.,0.,0.),(0.,0.,1.),(0.,1.,0.))"
COLOUR_INDEX = (1, 2, 3, 1, 2, 3, 2, 3, 1, 3, 1, 2)
UVS = [(0.125, 0.25), (0.875, 0.0625), (0.75, 0.9375), (0.0625, 0.8125), (0.3125, 0.5), (0.5625, 0.1875)]
UV_INDEX = [tuple(1 + (i * 5 + k * 2) % 6 for k in range(3)) for i in range(12)]
PRODUCTS = [("palette", 0.0, False), ("texture", 5.0, False), ("palette-cut", 10.0, True), ("texture-cut", 15.0, True)]

def tuples(rows):
    return "(" + ",".join("(" + ",".join(str(v) for v in row) + ")" for row in rows) + ")"

def generate():
    lines, next_id, cases = [], [1], []
    def add(text):
        identifier = next_id[0]; next_id[0] += 1
        lines.append(f"#{identifier}={text};")
        return f"#{identifier}"
    origin = add("IFCCARTESIANPOINT((0.,0.,0.))")
    axis = add(f"IFCAXIS2PLACEMENT3D({origin},$,$)")
    up = add("IFCDIRECTION((0.,0.,1.))")
    context = add(f"IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-7,{axis},$)")
    metre = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)")
    units = add(f"IFCUNITASSIGNMENT(({metre}))")
    add(f"IFCPROJECT('1VUKp4iK9NYQwBerZw_U4T',$,'SYNTHETIC qualification',$,$,$,$,({context}),{units})")
    for index, (name, x, cut) in enumerate(PRODUCTS):
        point_list = add(f"IFCCARTESIANPOINTLIST3D({POINTS})")
        face_set = add(f"IFCTRIANGULATEDFACESET({point_list},$,.T.,{tuples(TRIANGLES)},$)")
        if name.startswith("palette"):
            colours = add(f"IFCCOLOURRGBLIST({COLOURS})")
            add(f"IFCINDEXEDCOLOURMAP({face_set},1.,{colours},{tuple(COLOUR_INDEX)!s})".replace(" ", ""))
        else:
            image = add("IFCIMAGETEXTURE(.T.,.F.,$,$,$,'checker.png')")
            vertices = add("IFCTEXTUREVERTEXLIST(" + tuples(UVS) + ")")
            add(f"IFCINDEXEDTRIANGLETEXTUREMAP(({image}),{face_set},{vertices},{tuples(UV_INDEX)})")
        at = add(f"IFCCARTESIANPOINT(({x},0.,0.))")
        place = add(f"IFCLOCALPLACEMENT($,{add(f'IFCAXIS2PLACEMENT3D({at},$,$)')})")
        shape = add(f"IFCSHAPEREPRESENTATION({context},'Body','Tessellation',({face_set}))")
        definition = add(f"IFCPRODUCTDEFINITIONSHAPE($,$,({shape}))")
        product = add(f"IFCBUILDINGELEMENTPROXY('0zjUaDI8vMFBqKB7_XFO{index:02d}',$,'{name}',$,$,{place},{definition},$,.NOTDEFINED.)")
        if cut:
            centre = add("IFCCARTESIANPOINT((1.,0.5))")
            profile_at = add(f"IFCAXIS2PLACEMENT2D({centre},$)")
            profile = add(f"IFCRECTANGLEPROFILEDEF(.AREA.,$,{profile_at},0.5,2.)")
            solid = add(f"IFCEXTRUDEDAREASOLID({profile},{axis},{up},2.)")
            cut_shape = add(f"IFCSHAPEREPRESENTATION({context},'Body','SweptSolid',({solid}))")
            cut_definition = add(f"IFCPRODUCTDEFINITIONSHAPE($,$,({cut_shape}))")
            opening = add(f"IFCOPENINGELEMENT('0BKNXdiz5U$OjbVXwg0h{index:02d}',$,'{name}-opening',$,$,{place},{cut_definition},$,.OPENING.)")
            add(f"IFCRELVOIDSELEMENT('1xOjMtIuvMZR$N4P_nl${index:02d}',$,$,$,{product},{opening})")
            # 6 m3 box; the 0.5 x 2 x 2 cutter overlaps it over y in [0, 1]: 0.5 x 1 x 2 = 1 m3 removed.
            cases.append({"id": int(product[1:]), "role": name, "volume": 5, "opening_volume": 2,
                "opening_id": int(opening[1:]), "local_centroid": [1.1, 0.5, 1.6]})
    return HEADER + "\n".join(lines) + "\nENDSEC;\nEND-ISO-10303-21;\n", cases

here = pathlib.Path(__file__).parent
text, cases = generate()
oracle = json.dumps({"cases": {"f-t-face-set-presentation.ifc": {"products": cases}}}, indent=2) + "\n"
targets = {here / "f-t-face-set-presentation.ifc": text, here / "f-t-face-set-presentation.oracle.json": oracle}
if "--check" in sys.argv:
    sys.exit(0 if all(path.read_text() == body for path, body in targets.items()) else 1)
for path, body in targets.items():
    path.write_text(body)
