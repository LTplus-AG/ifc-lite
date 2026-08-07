/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CONSTRUCTION-PROJECTION half of the drawing pipeline (#2058 / #2060).
 *
 * The two sibling suites both run with `showConstructionProjection: false`, so
 * everything the hook does under `projectionOn` — the profile filters and the
 * storey-band scoping — was structurally unreachable from the test suite: the
 * `if (projectionOn)` blocks never executed anywhere. This file turns
 * projection ON so those lines run.
 *
 * Projection reaches the drawing by two routes that the mesh filters do NOT
 * cover:
 *
 *  1. `projectionProfiles` — extruded-area-solid outlines pulled straight out
 *     of the IFC source by `GeometryProcessor.extractProfiles`, never from
 *     `geometryResult.meshes`. Filtering the mesh list therefore does nothing
 *     to them; they need their own `isTypeVisible` pass (#2060).
 *  2. the storey bands — `storeyFloorsFromMeshes` derives per-storey floor
 *     levels from mesh geometry, and those levels decide how deep the
 *     projection reaches on each side of the cut (#2058).
 *
 * The profile suite drives the REAL wasm extractor over a real (inline) IFC
 * file, so the profiles under test are the ones production would get.
 */

import '@/test/setup-dom.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { IfcTypeEnum, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';
import type { TypeVisibilityGate } from '@/store/typeVisibilityFilter';
import { installInProcessOverlayWorker } from '@/test/overlay-worker-shim.js';
import { useDrawingGeneration } from './useDrawingGeneration.js';

// ─── Real wasm under happy-dom ───────────────────────────────────────────

/**
 * Let `GeometryProcessor.init()` load the engine in this environment.
 *
 * `@ifc-lite/geometry` reads the `.wasm` off disk only when
 * `typeof window === 'undefined'`; `setup-dom` defines `window`, so the bridge
 * takes the browser path and `fetch`es a `file:` URL, which happy-dom rejects.
 * The hook catches that and degrades to zero profiles — which would make every
 * profile assertion below pass VACUOUSLY, filter or no filter. Serving `file:`
 * from disk makes the real extractor run; the "class is visible" test is the
 * canary that it did.
 */
function serveFileUrlsFromDisk(): void {
  const upstream = globalThis.fetch;
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href =
      input instanceof URL ? input.href
      : typeof input === 'string' ? input
      : input.url;
    if (href.startsWith('file:')) {
      const bytes = await readFile(fileURLToPath(href));
      return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
    }
    return upstream(input, init);
  };
  globalThis.fetch = patched;

  // `WebAssembly.instantiateStreaming` is Node's and rejects happy-dom's
  // `Response` outright ("must be an instance of Response ... Received an
  // instance of Response"). wasm-bindgen only falls back to the buffered
  // `instantiate` when the streaming entry point is absent, so remove it for
  // this process; the buffered path compiles the same bytes.
  Reflect.deleteProperty(WebAssembly, 'instantiateStreaming');
}

let overlayShim: { restore(): void } | undefined;

before(() => {
  serveFileUrlsFromDisk();
  // The profile extraction now runs in the overlay worker (#2183). Node has no
  // `Worker`, so without this the hook resolves to zero profiles and every
  // assertion below would pass VACUOUSLY — the exact failure mode the
  // "class is visible" canary exists to catch. The shim runs the real handler
  // across a real structuredClone boundary.
  overlayShim = installInProcessOverlayWorker();
});
after(() => { overlayShim?.restore(); });

// ─── Fixture helpers ─────────────────────────────────────────────────────

/** Axis-aligned box in render space (Y-up), 12 triangles. The CPU cutter, the
 *  edge extractor and `storeyFloorsFromMeshes` only read positions/indices. */
function box(
  expressId: number,
  ifcType: string,
  geometryClass: number,
  min: [number, number, number],
  max: [number, number, number],
): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0,  x1, y0, z0,  x1, y1, z0,  x0, y1, z0,
    x0, y0, z1,  x1, y0, z1,  x1, y1, z1,  x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 1, 2,  0, 2, 3, // -z
    4, 6, 5,  4, 7, 6, // +z
    0, 4, 5,  0, 5, 1, // -y
    3, 2, 6,  3, 6, 7, // +y
    0, 3, 7,  0, 7, 4, // -x
    1, 5, 6,  1, 6, 2, // +x
  ]);
  return {
    expressId,
    ifcType,
    modelIndex: 0,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
    geometryClass,
  };
}

function geometry(
  meshes: MeshData[],
  min: [number, number, number],
  max: [number, number, number],
): GeometryResult {
  return {
    meshes,
    totalTriangles: meshes.length * 12,
    totalVertices: meshes.length * 8,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } },
      shiftedBounds:  { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } },
      hasLargeCoordinates: false,
    },
  };
}

const ALL_VISIBLE: TypeVisibilityGate = {
  spaces: true, spatialZones: true, openings: true,
  virtualElements: true, site: true, ifcAnnotations: true,
};

const SPACES_HIDDEN: TypeVisibilityGate = { ...ALL_VISIBLE, spaces: false };

interface HarnessOptions {
  geometryResult: GeometryResult;
  typeVisibility: TypeVisibilityGate;
  ifcDataStore: { source: Uint8Array; spatialHierarchy?: SpatialHierarchy } | null;
}

/** Drive the real hook once, with construction projection ON, and return the
 *  drawing it publishes. */
async function generate(options: HarnessOptions): Promise<Drawing2D | null> {
  let drawing: Drawing2D | null = null;
  let run: (() => Promise<void>) | null = null;

  function Harness(): null {
    const { generateDrawing } = useDrawingGeneration({
      geometryResult: options.geometryResult,
      ifcDataStore: options.ifcDataStore,
      sectionPlane: { axis: 'down', position: 50, flipped: false },
      displayOptions: {
        showHiddenLines: false,
        useSymbolicRepresentations: false,
        show3DOverlay: false,
        scale: 50,
        // The whole point of this file: the sibling suites leave this false,
        // which makes every `projectionOn` branch dead in the suite.
        showConstructionProjection: true,
      },
      typeVisibility: options.typeVisibility,
      combinedHiddenIds: new Set<number>(),
      combinedIsolatedIds: null,
      computedIsolatedIds: null,
      models: new Map([['m0', { id: 'm0', visible: true }]]),
      // Panel closed: the auto-generate effects stay out of the way so the
      // drawing under test is the one this harness asks for, not a race.
      panelVisible: false,
      drawing: null,
      setDrawing: (d) => { drawing = d; },
      setDrawingStatus: () => {},
      setDrawingProgress: () => {},
      setDrawingError: () => {},
    });
    run = generateDrawing;
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    assert.ok(run, 'harness never rendered — the hook was not called');
    await act(async () => { await run!(); });
    return drawing;
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

/** Entity ids that reached the drawing as PROJECTION (not cut) geometry. */
function projectedIds(drawing: Drawing2D | null): Set<number> {
  return new Set(
    (drawing?.lines ?? [])
      .filter((l) => l.category !== 'cut')
      .map((l) => l.entityId),
  );
}

// ─── Suite 1: the projection-profile visibility filter (#2060) ───────────

/**
 * Two extruded-area solids, an `IfcWall` and an `IfcSpace`, both 3 m tall from
 * z=0. `extractProfiles` returns one profile each (verified: express ids 38 and
 * 48), so the profile projector — which never looks at `geometryResult.meshes`
 * — is the ONLY route these reach the drawing by once the mesh filter has
 * dropped the hidden space.
 */
const PROFILE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('projection_profiles.ifc','2026-08-04T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#3));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#2,$);
#6=IFCDIRECTION((0.,0.,1.));
#19=IFCLOCALPLACEMENT($,#2);
#20=IFCSITE('0SITE56789ABCDEFGHIJKL',$,'Site',$,$,#19,$,$,.ELEMENT.,$,$,$,$,$);
#21=IFCLOCALPLACEMENT(#19,#2);
#22=IFCBUILDING('0BLDG56789ABCDEFGHIJKL',$,'Building',$,$,#21,$,$,.ELEMENT.,$,$,$);
#23=IFCLOCALPLACEMENT(#21,#2);
#24=IFCBUILDINGSTOREY('0STRY56789ABCDEFGHIJKL',$,'Storey',$,$,#23,$,$,.ELEMENT.,0.);
#25=IFCPROJECT('0PRJ456789ABCDEFGHIJKL',$,'Proj',$,$,$,$,(#5),#4);
#30=IFCCARTESIANPOINT((4.,0.));
#31=IFCAXIS2PLACEMENT2D(#30,$);
#32=IFCRECTANGLEPROFILEDEF(.AREA.,'WALL',#31,8.,0.4);
#33=IFCAXIS2PLACEMENT3D(#1,$,$);
#34=IFCEXTRUDEDAREASOLID(#32,#33,#6,3.);
#35=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#34));
#36=IFCPRODUCTDEFINITIONSHAPE($,$,(#35));
#37=IFCLOCALPLACEMENT(#23,#2);
#38=IFCWALL('0WALL56789ABCDEFGHIJKL',$,'Wall',$,$,#37,#36,$,$);
#40=IFCCARTESIANPOINT((4.,3.));
#41=IFCAXIS2PLACEMENT2D(#40,$);
#42=IFCRECTANGLEPROFILEDEF(.AREA.,'SPACE',#41,2.,2.);
#43=IFCAXIS2PLACEMENT3D(#1,$,$);
#44=IFCEXTRUDEDAREASOLID(#42,#43,#6,3.);
#45=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#44));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#47=IFCLOCALPLACEMENT(#23,#2);
#48=IFCSPACE('0SPAC56789ABCDEFGHIJKL',$,'Space',$,$,#47,#46,$,.ELEMENT.,$,$);
#62=IFCRELAGGREGATES('0REL156789ABCDEFGHIJKL',$,$,$,#25,(#20));
#63=IFCRELAGGREGATES('0REL256789ABCDEFGHIJKL',$,$,$,#20,(#22));
#64=IFCRELAGGREGATES('0REL356789ABCDEFGHIJKL',$,$,$,#22,(#24));
#65=IFCRELCONTAINEDINSPATIALSTRUCTURE('0REL456789ABCDEFGHIJKL',$,$,$,(#38),#24);
#66=IFCRELAGGREGATES('0REL556789ABCDEFGHIJKL',$,$,$,#24,(#48));
ENDSEC;
END-ISO-10303-21;
`;

/** Express ids as authored in `PROFILE_IFC`. */
const PROFILE_WALL_ID = 38;
const PROFILE_SPACE_ID = 48;

/**
 * Render-frame (Y-up) meshes: IFC (x,y,z) maps to (x, z, −y), so the 3 m
 * extrusion along +Z becomes the render Y span.
 *
 * Deliberately WALL ONLY. Giving the space a mesh too would let it reach the
 * drawing by the silhouette route as well, and "the space is absent" would then
 * be satisfied by the mesh filter (#2060's other half) with the profile filter
 * gone. With no space mesh, the profile is the space's ONLY route in — so both
 * assertions below are about the profile filter and nothing else.
 */
const PROFILE_MESHES: MeshData[] = [
  box(PROFILE_WALL_ID, 'IfcWall', 0, [0, 0, -0.2], [8, 3, 0.2]),
];

describe('useDrawingGeneration construction projection: profile visibility (#2060)', () => {
  it('drops a hidden class from the projection profiles', async () => {
    const drawing = await generate({
      geometryResult: geometry(PROFILE_MESHES, [0, 0, -0.2], [8, 3, 0.2]),
      typeVisibility: SPACES_HIDDEN,
      ifcDataStore: { source: new TextEncoder().encode(PROFILE_IFC) },
    });

    const ids = projectedIds(drawing);
    // Negative case: the visible wall's profile must still project, otherwise
    // this asserts nothing about the filter — only that projection is broken.
    assert.ok(
      ids.has(PROFILE_WALL_ID),
      `the visible wall must still project; got ${[...ids]}`,
    );
    assert.ok(
      !ids.has(PROFILE_SPACE_ID),
      `a hidden IfcSpace must not project through its extruded-solid profile; got ${[...ids]}`,
    );
  });

  it('keeps the same profile when the class is visible', async () => {
    // Pins that the assertion above is a VISIBILITY result, not an artefact of
    // the space having no extractable profile in the first place.
    const drawing = await generate({
      geometryResult: geometry(PROFILE_MESHES, [0, 0, -0.2], [8, 3, 0.2]),
      typeVisibility: ALL_VISIBLE,
      ifcDataStore: { source: new TextEncoder().encode(PROFILE_IFC) },
    });

    const ids = projectedIds(drawing);
    assert.ok(
      ids.has(PROFILE_SPACE_ID),
      `the space profile must project when Spaces are visible; got ${[...ids]}`,
    );
  });
});

// ─── Suite 2: storey bands are derived from the FILTERED mesh set (#2058) ─

/**
 * `storeyFloorsFromMeshes` reads the mesh list to place each storey's floor,
 * and those floors clamp how deep the projection reaches. Feeding it the raw
 * `geometryResult.meshes` lets a type-library template — which draws at the
 * MappingOrigin, not where any occurrence sits — contribute a floor level, and
 * a floor level between the cut and the storey below truncates the visible
 * (solid) band, culling geometry that belongs on the plan.
 *
 * Reachability, stated precisely: `elementToStorey` is built from
 * `IfcRelContainedInSpatialStructure` (products only), but
 * `spatial-hierarchy-builder.ts` then walks `IfcRelAggregates` from every
 * contained element and maps EVERY descendant to that storey with no type
 * check — and `IfcRelAggregates.RelatedObjects` is `IfcObjectDefinition`, which
 * admits `IfcTypeObject`. So a type product aggregated under a placed element
 * does land in `elementToStorey`. That is an unusual file shape, not the
 * AC20-FZK-Haus case: on a file where no type id reaches `elementToStorey` the
 * type template contributes no floor either way and the guard is inert. This
 * test pins the coupling — the band computation must see the same mesh set the
 * cut does — rather than reproducing a defect observed on a real model.
 */
const STOREY_LOWER = 1000;
const STOREY_UPPER = 1001;

const BASEMENT_SLAB = 10;   // must project: it is inside the lower storey's band
const CUT_WALL = 11;        // spans the cut, so the drawing has cut bounds
const UPPER_SLAB = 20;      // the upper storey's floor level
const TYPE_TEMPLATE = 900;  // instanced type template, drawn at the MappingOrigin

const STOREY_MESHES: MeshData[] = [
  box(BASEMENT_SLAB, 'IfcSlab',     0, [0, -2.5, 0], [4, -2.3, 4]),
  box(CUT_WALL,      'IfcWall',     0, [0, -3.0, 0], [4,  6.0, 0.2]),
  box(UPPER_SLAB,    'IfcSlab',     0, [0,  3.0, 0], [4,  3.2, 4]),
  // At the mapping origin (y = 0), between the cut and the storey below.
  box(TYPE_TEMPLATE, 'IfcWallType', 2, [0,  0.0, 0], [1,  2.0, 0.2]),
];

/** Minimal `SpatialHierarchy`: the hook reads `elementToStorey` and
 *  `byBuilding.size` only, but the interface is fully implemented so no cast is
 *  needed. */
function spatialHierarchy(elementToStorey: Map<number, number>): SpatialHierarchy {
  const project: SpatialNode = {
    expressId: 1, type: IfcTypeEnum.IfcProject, name: 'Proj', children: [], elements: [],
  };
  return {
    project,
    byStorey: new Map([
      [STOREY_LOWER, [BASEMENT_SLAB, CUT_WALL]],
      [STOREY_UPPER, [UPPER_SLAB]],
    ]),
    byBuilding: new Map([[2, []]]),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map([[STOREY_LOWER, -3], [STOREY_UPPER, 3]]),
    storeyHeights: new Map(),
    elementToStorey,
    getStoreyElements: (storeyId) => (storeyId === STOREY_LOWER ? [BASEMENT_SLAB, CUT_WALL] : [UPPER_SLAB]),
    getStoreyByElevation: () => null,
    getContainingSpace: () => null,
    getPath: () => [project],
  };
}

/** An IFC with no swept solids: profile extraction succeeds and returns
 *  nothing, so this suite exercises the band scoping in isolation from the
 *  profile path above. */
const NO_PROFILE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('storey_bands.ifc','2026-08-04T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#3));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#2,$);
#25=IFCPROJECT('0PRJ456789ABCDEFGHIJKL',$,'Proj',$,$,$,$,(#5),#4);
ENDSEC;
END-ISO-10303-21;
`;

describe('useDrawingGeneration construction projection: storey bands (#2058)', () => {
  it('excludes type-library geometry from the storey floor levels', async () => {
    // `elementToStorey` maps the type template to the UPPER storey — reachable
    // via the untyped `IfcRelAggregates` walk described above. Unfiltered, its
    // mapping-origin geometry (y = 0) drags that storey's floor from 3 down to
    // 0, so the cut at y = 1.5 lands in a phantom [0, …) band and the solid
    // band below the cut shrinks from 4.5 m to 1.5 m — cutting the basement
    // slab, ~3.8 m below the cut, out of the plan.
    const drawing = await generate({
      geometryResult: geometry(STOREY_MESHES, [0, -3, 0], [4, 6, 4]),
      typeVisibility: ALL_VISIBLE,
      ifcDataStore: {
        source: new TextEncoder().encode(NO_PROFILE_IFC),
        spatialHierarchy: spatialHierarchy(new Map([
          [BASEMENT_SLAB, STOREY_LOWER],
          [CUT_WALL, STOREY_LOWER],
          [UPPER_SLAB, STOREY_UPPER],
          [TYPE_TEMPLATE, STOREY_UPPER],
        ])),
      },
    });

    const ids = projectedIds(drawing);
    assert.ok(
      ids.has(BASEMENT_SLAB),
      `geometry inside the cut storey must project; the phantom band from the ` +
      `type template truncated it. got ${[...ids]}`,
    );
    // The template itself is never drawn — the mesh filter already removed it.
    assert.ok(
      !ids.has(TYPE_TEMPLATE),
      `the type template must not be drawn at all; got ${[...ids]}`,
    );
  });
});

// ─── Suite 3: the profile route must mirror the mesh-class gate (#2070 review) ─

/**
 * `selectModelMeshes` drops type-library geometry (geometryClass 1/2) from
 * `meshesToProcess` by express id (#2058). Until this suite, nothing checked
 * that `projectionProfiles` — a second, independent route into the drawing
 * that never reads `geometryClass` at all — respected the same exclusion.
 *
 * `extractProfiles` only walks `IfcProduct` entities today (verified against
 * `rust/core/src/schema_helpers.rs::has_geometry_by_name`, gated on
 * `is_subtype_of(IfcProduct)`), so it cannot itself emit a profile keyed to an
 * `IfcXxxType` id — that gate lives in a different crate and nothing pins it
 * from this side. This fixture reproduces the reachable half of the same
 * shape without depending on that Rust invariant: a REAL occurrence (`IfcWall`
 * #38, mesh + extruded-solid profile both real) whose mesh is tagged
 * `geometryClass: 2` — an instanced-type duplicate — alongside another placed
 * mesh so `selectModelMeshes` has occurrence geometry to compare against and
 * drops #38 from the cut. Before the fix, the profile route did not know
 * about that exclusion at all and still projected the wall's 3 m extrusion.
 */
const PLACED_SLAB_ID = 99; // keeps `hasOccurrenceGeometry` true and the cut non-empty; no matching IFC entity, so it has no profile of its own.

const CLASS_GATE_MESHES: MeshData[] = [
  box(PROFILE_WALL_ID, 'IfcWall', 2, [0, 0, -0.2], [8, 3, 0.2]), // instanced-type duplicate — must be dropped from the cut AND the projection
  box(PLACED_SLAB_ID, 'IfcSlab', 0, [0, 0, -0.2], [8, 3, 0.2]),
];

describe('useDrawingGeneration construction projection: profile route mirrors the mesh-class gate (#2070)', () => {
  it('does not project a profile whose express id was dropped from the cut as type-library geometry', async () => {
    const drawing = await generate({
      geometryResult: geometry(CLASS_GATE_MESHES, [0, 0, -0.2], [8, 3, 0.2]),
      typeVisibility: ALL_VISIBLE,
      ifcDataStore: { source: new TextEncoder().encode(PROFILE_IFC) },
    });

    const ids = projectedIds(drawing);
    assert.ok(
      !ids.has(PROFILE_WALL_ID),
      `a geometryClass-2 wall dropped from the cut must not reach the drawing ` +
      `via its extruded-solid profile either; got ${[...ids]}`,
    );
    // Control: an express id with NO mesh at all (the space, #48, absent from
    // CLASS_GATE_MESHES) never went through the class gate, so this filter
    // must leave it alone — proving the fix targets ids the gate actually
    // excluded, not profiles in general.
    assert.ok(
      ids.has(PROFILE_SPACE_ID),
      `a mesh-less entity's profile must be unaffected by the class-gate ` +
      `mirror; got ${[...ids]}`,
    );
  });
});
