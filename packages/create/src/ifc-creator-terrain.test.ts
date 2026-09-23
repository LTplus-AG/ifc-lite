/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-creator-terrain.ts`, reached only through `IfcCreator.terrain()`.
 *
 * Every case here pins a constraint that fails open rather than loud in a
 * STEP file — an omitted `Closed`, an empty `Flags`, a product hung off the
 * wrong spatial container — so assertions read the actual emitted STEP
 * lines, not just "the type name is somewhere in the file". See
 * `docs/architecture/landxml-to-ifc-mapping.md` §4.1 and §4.2 for the IFC
 * rules being enforced.
 */

import { describe, it, expect } from 'vitest';
import { IfcCreator } from './ifc-creator.js';
import type { TerrainSurfaceParams } from './ifc-creator-terrain.js';

function creator4x3(): IfcCreator {
  return new IfcCreator({ Name: 'Terrain Test', Schema: 'IFC4X3' });
}

/**
 * Enter through the creator's public seam, asserting the seam itself first.
 *
 * Two reasons this is a function rather than a bare `creator.terrain()` at
 * each call site. It states, once, that `terrain()` is the only supported way
 * in — the emitters are not exported for direct use. And when the accessor is
 * absent it fails with that sentence instead of a bare
 * `TypeError: creator.terrain is not a function`, which reads as a broken test
 * rather than as the missing API it actually is.
 */
function terrainOf(creator: IfcCreator): ReturnType<IfcCreator['terrain']> {
  const seam = (creator as { terrain?: unknown }).terrain;
  expect(typeof seam, 'IfcCreator.terrain() is the seam these tests enter through').toBe('function');
  return creator.terrain();
}

/** A small, valid TIN: a unit-ish square split into two triangles. */
const SQUARE_SURFACE: TerrainSurfaceParams = {
  Name: 'Existing Ground',
  Coordinates: [
    [0, 0, 10],
    [10, 0, 11],
    [10, 10, 12],
    [0, 10, 10.5],
  ],
  Triangles: [
    [1, 2, 3],
    [1, 3, 4],
  ],
};

// ----------------------------------------------------------------------------
// STEP-line helpers. IfcCreator hands back express ids from its public API,
// so every helper resolves against a *known* id rather than guessing at file
// order — the one exception (idOfFirst/allLines) is used only where the test
// itself establishes there is exactly one candidate line.
// ----------------------------------------------------------------------------

/** The attribute string of one STEP line: "#12=IFCFOO(...);" -> "...". */
function argsOf(content: string, id: number): string {
  const m = content.match(new RegExp(`^#${id}=\\w+\\(([\\s\\S]*?)\\);$`, 'm'));
  if (!m) throw new Error(`Entity #${id} not found in content`);
  return m[1];
}

/** The full STEP line for one express id. */
function fullLine(content: string, id: number): string {
  const m = content.match(new RegExp(`^#${id}=\\w+\\([\\s\\S]*?\\);$`, 'm'));
  if (!m) throw new Error(`Entity #${id} not found in content`);
  return m[0];
}

/** The express id of the first line of a given entity type, in file order. */
function idOfFirst(content: string, type: string): number {
  const m = content.match(new RegExp(`^#(\\d+)=${type}\\(`, 'm'));
  if (!m) throw new Error(`No ${type} entity found in content`);
  return Number(m[1]);
}

/** All full STEP lines of a given entity type, in file order. */
function allLines(content: string, type: string): string[] {
  return content.match(new RegExp(`^#\\d+=${type}\\([\\s\\S]*?\\);$`, 'gm')) ?? [];
}

/** The express id a raw STEP line starts with. */
function idOf(line: string): number {
  const m = line.match(/^#(\d+)=/);
  if (!m) throw new Error(`Malformed STEP line: ${line}`);
  return Number(m[1]);
}

/**
 * `IfcTriangulatedIrregularNetwork.Flags` is the last attribute and is
 * always a flat, trailing `(n,n,...)` list — the rightmost parenthesised
 * group in the attribute string, even though `CoordIndex` earlier in the
 * same line is itself full of parens and commas.
 */
function flagsOf(content: string, tinId: number): number[] {
  const args = argsOf(content, tinId);
  const text = args.slice(args.lastIndexOf('(') + 1, args.lastIndexOf(')'));
  return text.split(',').map(Number);
}

describe('IfcCreator.terrain()', () => {
  it('writes a terrain surface as CartesianPointList3D -> TriangulatedIrregularNetwork -> ShapeRepresentation(Body,Tessellation) -> ProductDefinitionShape -> GeographicElement/.TERRAIN.', () => {
    const creator = creator4x3();
    const { elementId, tinId, coordinateListId } = terrainOf(creator).addSurface(SQUARE_SURFACE);
    const { content } = creator.toIfc();

    expect(fullLine(content, coordinateListId)).toBe(
      `#${coordinateListId}=IFCCARTESIANPOINTLIST3D(((0.,0.,10.),(10.,0.,11.),(10.,10.,12.),(0.,10.,10.5)),$);`,
    );

    expect(fullLine(content, tinId)).toBe(
      `#${tinId}=IFCTRIANGULATEDIRREGULARNETWORK(#${coordinateListId},.F.,$,((1,2,3),(1,3,4)),$,(0));`,
    );

    // Only one surface was added, so there is exactly one of each.
    const repId = idOfFirst(content, 'IFCSHAPEREPRESENTATION');
    expect(fullLine(content, repId)).toContain(`,'Body','Tessellation',(#${tinId}));`);

    const shapeId = idOfFirst(content, 'IFCPRODUCTDEFINITIONSHAPE');
    expect(fullLine(content, shapeId)).toBe(`#${shapeId}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${repId}));`);

    const elementLine = fullLine(content, elementId);
    expect(elementLine).toContain('=IFCGEOGRAPHICELEMENT(');
    expect(elementLine).toContain("'Existing Ground'");
    expect(elementLine.endsWith(`,#${shapeId},$,.TERRAIN.);`)).toBe(true);
  });

  it('writes Closed as the literal .F., not $ — NotClosed : Closed = FALSE fails open on $', () => {
    const creator = creator4x3();
    const { tinId } = terrainOf(creator).addSurface(SQUARE_SURFACE);
    const { content } = creator.toIfc();

    // FINAL IFC4X3 attribute order: Coordinates, Closed, Normals, CoordIndex,
    // PnIndex, Flags. The repo's codegen schema is a DEV draft that lists
    // `Normals` before `Closed`; following it put `.F.` into `Normals`, which
    // `ifcopenshell.validate` rejects. Neither leading attribute contains a
    // comma, so a plain split lands exactly on each.
    const [, closed, normals] = argsOf(content, tinId).split(',');
    expect(closed, 'Closed is the second attribute in final IFC4X3').toBe('.F.');
    expect(normals, 'Normals is optional and absent').toBe('$');
  });

  it('Flags is non-empty by default, a supplied Flags is written verbatim, and invalid Flags throw', () => {
    const creator = creator4x3();
    const writer = terrainOf(creator);

    const defaultSurface = writer.addSurface(SQUARE_SURFACE);
    const customSurface = writer.addSurface({ ...SQUARE_SURFACE, Flags: [3, 7] });

    expect(() => writer.addSurface({ ...SQUARE_SURFACE, Flags: [] }))
      .toThrow(/Flags is empty/);
    expect(() => writer.addSurface({ ...SQUARE_SURFACE, Flags: [1.5] }))
      .toThrow(/Flags entry 1\.5 is not an integer/);

    const { content } = creator.toIfc();
    expect(flagsOf(content, defaultSurface.tinId)).toEqual([0]);
    expect(flagsOf(content, customSurface.tinId)).toEqual([3, 7]);
  });

  it('writes CoordIndex 1-based and verbatim from Triangles', () => {
    const creator = creator4x3();
    const { tinId, coordinateListId } = terrainOf(creator).addSurface({
      Name: 'Distinct Vertices',
      Coordinates: [
        [111, 211, 1],
        [122, 222, 2],
        [133, 233, 3],
      ],
      // Deliberately unordered and not starting at the first vertex — proves
      // the indices are written through, not renumbered or sorted.
      Triangles: [[3, 1, 2]],
    });
    const { content } = creator.toIfc();

    // CoordList position 1 (STEP LIST indices are 1-based) is Coordinates[0]
    // — this is what index "1" in CoordIndex below resolves to.
    expect(fullLine(content, coordinateListId)).toBe(
      `#${coordinateListId}=IFCCARTESIANPOINTLIST3D(((111.,211.,1.),(122.,222.,2.),(133.,233.,3.)),$);`,
    );
    expect(argsOf(content, tinId)).toContain('((3,1,2))');
  });

  it('rejects invalid surface input with a message naming the violated constraint', () => {
    const creator = creator4x3();
    const writer = terrainOf(creator);
    const valid = SQUARE_SURFACE;

    expect(() => writer.addSurface({ ...valid, Coordinates: [] }))
      .toThrow(/Coordinates is empty/);
    expect(() => writer.addSurface({ ...valid, Triangles: [] }))
      .toThrow(/Triangles is empty/);
    expect(() => writer.addSurface({ ...valid, Triangles: [[0, 1, 2]] }))
      .toThrow(/references vertex 0/);
    expect(() => writer.addSurface({ ...valid, Triangles: [[1, 2, 5]] })) // valid has 4 vertices
      .toThrow(/references vertex 5/);
    expect(() => writer.addSurface({ ...valid, Triangles: [[1, 2, 2.5]] }))
      .toThrow(/references vertex 2\.5/);
    expect(() => writer.addSurface({ ...valid, Coordinates: [[NaN, 0, 0], [1, 0, 0], [0, 1, 0]] }))
      .toThrow(/coordinate 0 is NaN/);
    expect(() => writer.addSurface({ ...valid, Coordinates: [[0, 0, Infinity], [1, 0, 0], [0, 1, 0]] }))
      .toThrow(/coordinate 2 is Infinity/);
  });

  it('contains terrain and survey products in the site, not a storey', () => {
    const creator = creator4x3();
    const writer = terrainOf(creator);
    const { elementId } = writer.addSurface(SQUARE_SURFACE);
    const surveyId = writer.addSurveyPoint({ Name: 'CP1', Location: [1, 2, 3] });
    const { content } = creator.toIfc();

    const siteId = idOfFirst(content, 'IFCSITE');

    // No storey was ever created in this creator, so if terrain/survey
    // products are (still) contained in the site, this is the *only*
    // contained-in row the file has. A regression that hangs them off a
    // fabricated storey would either add a second row or retarget this one.
    const containedLines = allLines(content, 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(containedLines.length).toBe(1);

    const relArgs = argsOf(content, idOf(containedLines[0]));
    expect(relArgs.endsWith(`#${siteId}`)).toBe(true); // RelatingStructure is the last attribute
    expect(relArgs).toContain(`#${elementId}`);
    expect(relArgs).toContain(`#${surveyId}`);
  });

  it('writes a survey point as IfcAnnotation/.SURVEY. with the coordinate in the placement, not the representation', () => {
    const creator = creator4x3();
    const surveyId = terrainOf(creator).addSurveyPoint({ Name: 'CP7', Location: [123.4, 567.8, 9.1] });
    const { content } = creator.toIfc();

    const annotationLine = fullLine(content, surveyId);
    expect(annotationLine).toContain('=IFCANNOTATION(');
    expect(annotationLine.endsWith('.SURVEY.);')).toBe(true);

    // The world preamble already writes its own IFCCARTESIANPOINT at
    // (0.,0.,0.), so pick out the real coordinate by value, not by count.
    const realLine = allLines(content, 'IFCCARTESIANPOINT').find((l) => l.includes('(123.4,567.8,9.1)'));
    if (!realLine) throw new Error('No IFCCARTESIANPOINT holds the real survey coordinate');
    const realId = idOf(realLine);

    // The 'Point','Point' representation is an IfcCartesianPoint at the
    // LOCAL ORIGIN (0.,0.,0.), never the real one. This is the exact line a
    // regression that puts the real coordinate in the representation would
    // change.
    const repId = idOfFirst(content, 'IFCSHAPEREPRESENTATION');
    const repLine = fullLine(content, repId);
    const repMatch = repLine.match(/'Point','Point',\(#(\d+)\)/);
    if (!repMatch) throw new Error(`IFCSHAPEREPRESENTATION #${repId} is not a 'Point','Point' representation: ${repLine}`);
    const originId = Number(repMatch[1]);
    expect(fullLine(content, originId)).toContain('(0.,0.,0.)');
    expect(repLine).not.toContain(`#${realId}`);

    // The real coordinate lives in the IfcAxis2Placement3D -> IfcLocalPlacement
    // chain that IfcAnnotation.ObjectPlacement points to. Resolved by
    // reference rather than file order, because the preamble already wrote
    // one world IfcAxis2Placement3D / IfcLocalPlacement before this point.
    const axisLine = allLines(content, 'IFCAXIS2PLACEMENT3D').find((l) => l.includes(`#${realId}`));
    if (!axisLine) throw new Error('No IFCAXIS2PLACEMENT3D references the real coordinate');
    const placementLine = allLines(content, 'IFCLOCALPLACEMENT').find((l) => l.includes(`#${idOf(axisLine)}`));
    if (!placementLine) throw new Error('No IFCLOCALPLACEMENT references the survey point axis');
    expect(annotationLine).toContain(`#${idOf(placementLine)}`);
  });

  it('writes a property set as IfcPropertySet + IfcRelDefinesByProperties, every value as IFCLABEL, preserving a leading zero', () => {
    const creator = creator4x3();
    const writer = terrainOf(creator);
    const surveyId = writer.addSurveyPoint({ Name: 'CP1', Location: [0, 0, 0] });
    const psetId = writer.addPropertySet(surveyId, {
      Name: 'LandXML Attributes',
      Properties: [
        { Name: 'PointID', Value: '00123' },
        { Name: 'Code', Value: 'BM' },
      ],
    });

    expect(() => writer.addPropertySet(surveyId, { Name: 'Empty', Properties: [] }))
      .toThrow(/Properties is empty/);

    const { content } = creator.toIfc();

    const pointIdLine = allLines(content, 'IFCPROPERTYSINGLEVALUE').find((l) => l.includes("'PointID'"));
    if (!pointIdLine) throw new Error('IFCPROPERTYSINGLEVALUE for PointID not found');
    // A leading zero identifies the point; IFCLABEL keeps it as text. A
    // regression that promotes numeric-looking values (e.g. to IFCREAL or a
    // bare IFCLABEL(00123)) would lose the leading zero.
    expect(pointIdLine).toContain("IFCLABEL('00123')");

    const psetLine = fullLine(content, psetId);
    expect(psetLine).toContain("'LandXML Attributes'");

    const relId = idOfFirst(content, 'IFCRELDEFINESBYPROPERTIES');
    const relArgs = argsOf(content, relId);
    expect(relArgs).toContain(`#${surveyId}`);
    expect(relArgs.endsWith(`#${psetId}`)).toBe(true);
  });

  it('setGeoreferencing writes IfcProjectedCRS + IfcMapConversion (SourceCRS = model context, TargetCRS = the projected CRS), defaults MapUnit to the file length unit, refuses a second call, and refuses an empty Name', () => {
    const creator = creator4x3();
    const writer = terrainOf(creator);
    const { crsId, mapConversionId } = writer.setGeoreferencing({
      Name: 'EPSG:2056',
      Eastings: 2600000,
      Northings: 1200000,
    });

    expect(() => writer.setGeoreferencing({ Name: 'Other CRS' })).toThrow(/already called/);

    const { content } = creator.toIfc();

    const contextId = idOfFirst(content, 'IFCGEOMETRICREPRESENTATIONCONTEXT');
    // Default project has one length unit and no LengthUnit override, so it
    // is the first IFCSIUNIT the file writes.
    const lengthUnitId = idOfFirst(content, 'IFCSIUNIT');

    const crsArgs = argsOf(content, crsId);
    expect(crsArgs).toContain("'EPSG:2056'");
    expect(crsArgs.endsWith(`#${lengthUnitId}`)).toBe(true); // MapUnit is the last attribute

    // TargetCRSOnlyProjected: SourceCRS is the model context, TargetCRS the
    // IfcProjectedCRS just written — in that order.
    expect(argsOf(content, mapConversionId).startsWith(`#${contextId},#${crsId},`)).toBe(true);

    const freshCreator = creator4x3();
    expect(() => terrainOf(freshCreator).setGeoreferencing({ Name: '' })).toThrow(/Name is empty/);
  });

  it('throws on a non-IFC4X3 schema for addSurface, addSurveyPoint and setGeoreferencing, naming the schema', () => {
    for (const schema of ['IFC4', 'IFC2X3'] as const) {
      const creator = new IfcCreator({ Name: 'Wrong Schema', Schema: schema });
      const writer = terrainOf(creator);
      const namesTheSchema = new RegExp(`in ${schema}$`);

      expect(() => writer.addSurface(SQUARE_SURFACE)).toThrow(namesTheSchema);
      expect(() => writer.addSurveyPoint({ Location: [0, 0, 0] })).toThrow(namesTheSchema);
      expect(() => writer.setGeoreferencing({ Name: 'CRS' })).toThrow(namesTheSchema);
    }
  });
});
