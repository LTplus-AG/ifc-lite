/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScriptPreflight, validateScriptPreflightDetailed } from './script-preflight.js';

test('preflight accepts valid dedicated create methods', () => {
  const code = `
const h = bim.create.project({ Name: "Schema Coverage" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWall(h, s0, {
  Name: "Wall",
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3,
});
bim.create.addIfcSlab(h, s0, {
  Name: "Slab",
  Position: [0, 0, 0],
  Width: 5,
  Depth: 4,
  Thickness: 0.3,
});
`;

  const errors = validateScriptPreflight(code);
  assert.deepEqual(errors, []);
});

test('preflight suggests nearest method names for typos', () => {
  const code = `
const h = bim.create.project({ Name: "Typo" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWal(h, s0, { Start: [0, 0, 0], End: [1, 0, 0], Thickness: 0.2, Height: 3 });
`;

  const errors = validateScriptPreflight(code);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Did you mean `bim\.create\.addIfcWall\(\)`\?/);
});

test('preflight warns when standalone windows are used with walls but no wall openings exist', () => {
  const code = `
const h = bim.create.project({ Name: "Window House" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3,
});
bim.create.addIfcWindow(h, s0, {
  Position: [2.5, 0, 1.0],
  Width: 1.2,
  Height: 1.2,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('world-aligned standalone window')));
  assert.ok(errors.some((error) => error.includes('addIfcWallWindow')));
});

test('preflight accepts wall openings without standalone windows', () => {
  const code = `
const h = bim.create.project({ Name: "Window House" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3,
  Openings: [
    { Width: 1.2, Height: 1.2, Position: [2.5, 0, 1.0] },
  ],
});
`;
  const errors = validateScriptPreflight(code);
  assert.deepEqual(errors, []);
});

test('preflight accepts hosted wall window helper usage', () => {
  const code = `
const h = bim.create.project({ Name: "Window House" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
const wall = bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3,
});
bim.create.addIfcWallWindow(h, wall, {
  Position: [2.5, 0, 1.0],
  Width: 1.2,
  Height: 1.2,
});
`;
  const errors = validateScriptPreflight(code);
  assert.deepEqual(errors, []);
});

test('preflight emits one targeted diagnostic per standalone opening call', () => {
  const diagnostics = validateScriptPreflightDetailed(`
const h = bim.create.project({ Name: "Window House" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3,
});
bim.create.addIfcDoor(h, s0, {
  Position: [1.0, 0, 0],
  Width: 1.0,
  Height: 2.1,
});
bim.create.addIfcWindow(h, s0, {
  Position: [2.5, 0, 1.0],
  Width: 1.2,
  Height: 1.2,
});
`);

  const openingDiagnostics = diagnostics.filter((diagnostic) => diagnostic.code === 'wall_hosted_opening_pattern');
  assert.equal(openingDiagnostics.length, 2);
  assert.deepEqual(
    openingDiagnostics.map((diagnostic) => diagnostic.data?.methodName).sort(),
    ['addIfcDoor', 'addIfcWindow'],
  );
  assert.ok(openingDiagnostics.every((diagnostic) => diagnostic.rootCauseKey === 'placement_context_mismatch'));
  assert.ok(openingDiagnostics.every((diagnostic) => diagnostic.repairScope === 'block'));
  assert.ok(openingDiagnostics.every((diagnostic) => typeof diagnostic.data?.snippet === 'string'));
  assert.ok(openingDiagnostics.every((diagnostic) => diagnostic.data?.range));
});

test('preflight can target an unterminated standalone opening fragment', () => {
  const diagnostics = validateScriptPreflightDetailed(`
const h = bim.create.project({ Name: "Broken" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3,
});
bim.create.addIfcDoor(h, s0, {
  Name: "Front Door",
// truncated repair debris
`);

  const openingDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === 'wall_hosted_opening_pattern');
  assert.equal(openingDiagnostic?.data?.methodName, 'addIfcDoor');
  assert.equal(openingDiagnostic?.data?.unterminated, true);
  assert.match(String(openingDiagnostic?.data?.snippet ?? ''), /addIfcDoor/);
});

test('preflight rejects addIfcPlate slab-style contract misuse', () => {
  const code = `
const h = bim.create.project({ Name: "Facade" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcPlate(h, s0, {
  Position: [0, 0, 0],
  Width: 2.8,
  Height: 3.0,
  Thickness: 0.08,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('uses `Depth` and `Thickness`, not `Height`')));
  assert.ok(errors.some((error) => error.includes('missing required key(s): `Depth`')));
});

// Every `bim.create.addIfc*(h, storey, ...)` coordinate is relative to that
// storey, whose placement already carries `Elevation`. Repeating the elevation
// in an element Z puts it at 2x the level height — the failure that shipped a
// real model with its walls 1.37 m below the spaces they bounded.
const TOWER_LOOP = (curtainWallZ: string) => `
const h = bim.create.project({ Name: "Tower" });
const storeyHeight = 3.5;
const storeyCount = 10;
for (let i = 0; i < storeyCount; i++) {
  const elevation = i * storeyHeight;
  const storey = bim.create.addIfcBuildingStorey(h, { Name: "Level " + i, Elevation: elevation });
  bim.create.addIfcCurtainWall(h, storey, {
    Start: [0, -0.2, ${curtainWallZ}],
    End: [30, -0.2, ${curtainWallZ}],
    Height: storeyHeight,
    Thickness: 0.15,
  });
}
`;

test('preflight rejects a storey-loop element that repeats the level elevation in its Z', () => {
  const errors = validateScriptPreflight(TOWER_LOOP('elevation'));
  assert.ok(errors.some((error) => error.includes('Storey elevation applied twice')));
});

test('preflight accepts storey-relative Z in a storey loop', () => {
  const errors = validateScriptPreflight(TOWER_LOOP('0'));
  assert.ok(!errors.some((error) => error.includes('Storey elevation applied twice')));
});

test('preflight does not flag an ordinary `z` variable as a doubled elevation', () => {
  const code = `
const h = bim.create.project({ Name: "Tower" });
const storeyCount = 3;
for (let i = 0; i < storeyCount; i++) {
  const storey = bim.create.addIfcBuildingStorey(h, { Name: "Level " + i, Elevation: i * 3 });
  const z = 0;
  bim.create.addIfcColumn(h, storey, { Position: [0, 0, z], Width: 0.4, Depth: 0.4, Height: 3 });
}
`;
  const errors = validateScriptPreflight(code);
  assert.ok(!errors.some((error) => error.includes('Storey elevation applied twice')));
});

test('preflight warns when material is queried via property sets', () => {
  const code = `
const entities = bim.query.all();
for (const entity of entities) {
  const material = bim.query.property(entity, "Pset_MaterialCommon", "Material")
    ?? bim.query.property(entity, "Material", "Name");
  console.log(material);
}
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('Prefer `bim.query.materials(entity)`')));
});

test('preflight returns structured diagnostics with codes', () => {
  const diagnostics = validateScriptPreflightDetailed(`
const entities = bim.query.all();
for (const entity of entities) {
  const material = bim.query.property(entity, "Pset_MaterialCommon", "Material");
  console.log(material);
}
`);

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'metadata_query_pattern'));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.source === 'preflight'));
});

test('preflight diagnostics include method metadata when available', () => {
  const diagnostics = validateScriptPreflightDetailed(`
const h = bim.create.project({ Name: "Facade" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcPlate(h, s0, {
  Position: [0, 0, 0],
  Width: 2.8,
  Height: 3.0,
  Thickness: 0.08,
});
`);

  const contractDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === 'create_contract');
  assert.equal(contractDiagnostic?.data?.methodName, 'addIfcPlate');
});

test('preflight warns on detached snippet scope for common facade variables', () => {
  const code = `
for (let x = 0; x < width; x += 3) {
  bim.create.addIfcMember(h, storey, {
    Start: [x, -0.2, z],
    End: [x, -0.2, z + 3.5],
    Width: 0.25,
    Height: 0.15,
  });
}
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('reference `h`')));
  assert.ok(errors.some((error) => error.includes('reference `storey`')));
  assert.ok(errors.some((error) => error.includes('references `width`')));
  assert.ok(errors.some((error) => error.includes('references `z`')));
});

test('preflight detached snippet diagnostics carry structural repair metadata and evidence', () => {
  const diagnostics = validateScriptPreflightDetailed(`
for (let x = 0; x < width; x += 3) {
  bim.create.addIfcMember(h, storey, {
    Start: [x, -0.2, z],
    End: [x, -0.2, z + 3.5],
    Width: 0.25,
    Height: 0.15,
  });
}
`);

  const detached = diagnostics.filter((diagnostic) => diagnostic.code === 'detached_snippet_scope');
  assert.ok(detached.length >= 3);
  assert.ok(detached.every((diagnostic) => diagnostic.rootCauseKey === 'detached_fragment_rewrite'));
  assert.ok(detached.every((diagnostic) => diagnostic.repairScope === 'structural'));
  assert.ok(detached.every((diagnostic) => diagnostic.evidence?.length));
});

test('preflight does not flag destructured loop bindings in complete rewrite scripts as detached snippets', () => {
  const diagnostics = validateScriptPreflightDetailed(`
const h = bim.create.project({ Name: "3-Story House" });

const storyHeight = 3.0;
const floorThickness = 0.3;
const wallThickness = 0.25;
const roofThickness = 0.25;
const windowWidth = 1.2;
const windowHeight = 1.5;
const windowSillHeight = 0.9;

const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Ground Floor", Elevation: 0 });
const s1 = bim.create.addIfcBuildingStorey(h, { Name: "First Floor", Elevation: storyHeight });
const s2 = bim.create.addIfcBuildingStorey(h, { Name: "Second Floor", Elevation: storyHeight * 2 });

for (const [i, storey] of [s0, s1, s2].entries()) {
  bim.create.addIfcWall(h, storey, {
    Name: "North Wall Level " + i,
    Start: [0, 0, 0],
    End: [10, 0, 0],
    Height: storyHeight,
    Thickness: wallThickness,
    Openings: [
      {
        Position: [2.5, 0, windowSillHeight],
        Width: windowWidth,
        Height: windowHeight
      }
    ]
  });
}

bim.create.addIfcGableRoof(h, s2, {
  Name: "Gable Roof",
  Position: [0, 0, storyHeight],
  Width: 10,
  Depth: 8,
  Thickness: roofThickness,
  Slope: 30 * Math.PI / 180,
  Overhang: 0.5
});

const result = bim.create.toIfc(h);
bim.model.loadIfc(result.content, "3-story-house-with-windows.ifc");
`);

  const detached = diagnostics.filter((diagnostic) => diagnostic.code === 'detached_snippet_scope');
  assert.equal(detached.length, 0);
});

test('preflight does not flag object destructuring or arrow params as detached snippets', () => {
  const diagnostics = validateScriptPreflightDetailed(`
const h = bim.create.project({ Name: "Facade" });
const storey = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
const footprint = { width: 10, depth: 8 };
const { width, depth } = footprint;
const buildWall = (z) => {
  bim.create.addIfcWall(h, storey, {
    Start: [0, 0, z],
    End: [width, 0, z],
    Height: 3,
    Thickness: 0.25,
  });
};
buildWall(0);

const result = bim.create.toIfc(h);
bim.model.loadIfc(result.content, "facade.ifc");
`);

  const detached = diagnostics.filter((diagnostic) => diagnostic.code === 'detached_snippet_scope');
  assert.equal(detached.length, 0);
});

test('preflight rejects unsupported rotation keys on windows', () => {
  const code = `
const h = bim.create.project({ Name: "Rotated Window" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWindow(h, s0, {
  Position: [2.5, 0, 1.0],
  Width: 1.2,
  Height: 1.2,
  Rotation: Math.PI / 2,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('does not support rotation')));
});

test('preflight rejects unsupported rotation keys on hosted wall windows', () => {
  const code = `
const h = bim.create.project({ Name: "Rotated Hosted Window" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
const wall = bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.2,
  Height: 3,
});
bim.create.addIfcWallWindow(h, wall, {
  Position: [2.5, 0, 1.0],
  Width: 1.2,
  Height: 1.2,
  Rotation: Math.PI / 2,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('auto-aligns to the host wall')));
});

test('preflight rejects invalid addElement contract shape', () => {
  const code = `
const h = bim.create.project({ Name: "Bad Generic" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addElement(h, s0, {
  Type: "IfcBuildingElementProxy",
  Position: [0, 0, 0],
  Profile: { kind: "rect", xDim: 1, yDim: 1 },
  Height: 3,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('uses `IfcType`, not `Type`')));
  assert.ok(errors.some((error) => error.includes('uses `Placement: { Location: [...] }`, not `Position`')));
  assert.ok(errors.some((error) => error.includes('uses `Depth`, not `Height`')));
  assert.ok(errors.some((error) => error.includes('ProfileType')));
});

test('preflight rejects unsupported roof profile geometry', () => {
  const code = `
const h = bim.create.project({ Name: "Roof" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcRoof(h, s0, {
  Name: "Bad Roof",
  Position: [0, 0, 3],
  Profile: [[0, 0], [1, 0], [1, 1]],
  Thickness: 0.2,
  Width: 10,
  Depth: 8,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('does not support `Profile`')));
});

test('preflight rejects roof slopes that look like degrees', () => {
  const code = `
const h = bim.create.project({ Name: "Roof Degrees" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcRoof(h, s0, {
  Name: "Bad Roof",
  Position: [0, 0, 3],
  Width: 10,
  Depth: 8,
  Thickness: 0.2,
  Slope: 15,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('convert them first')));
});

test('preflight steers gable intent to addIfcGableRoof', () => {
  const code = `
const h = bim.create.project({ Name: "Gable" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcRoof(h, s0, {
  Name: "Main Gable Roof",
  Position: [0, 0, 3],
  Width: 10,
  Depth: 8,
  Thickness: 0.2,
  Slope: Math.PI / 12,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('addIfcGableRoof')));
});

test('preflight accepts valid gable roof helper usage', () => {
  const code = `
const h = bim.create.project({ Name: "Gable" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcGableRoof(h, s0, {
  Name: "Main Roof",
  Position: [0, 0, 3],
  Width: 10,
  Depth: 8,
  Thickness: 0.2,
  Slope: Math.PI / 12,
  Overhang: 0.3,
});
`;
  const errors = validateScriptPreflight(code);
  assert.deepEqual(errors, []);
});

test('preflight rejects slab missing footprint and profile', () => {
  const code = `
const h = bim.create.project({ Name: "Slab" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcSlab(h, s0, {
  Position: [0, 0, 0],
  Thickness: 0.3,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('requires one of')));
});

test('preflight rejects zero-length axis geometry', () => {
  const code = `
const h = bim.create.project({ Name: "Axis" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcWall(h, s0, {
  Start: [0, 0, 0],
  End: [0, 0, 0],
  Thickness: 0.2,
  Height: 3,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('non-zero axis')));
});

test('preflight rejects suspicious bare identifier values', () => {
  const code = `
const h = bim.create.project({ Name: "Bare" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
bim.create.addIfcColumn(h, s0, {
  Position: Position,
  Width: 0.4,
  Depth: 0.4,
  Height: 3,
});
`;
  const errors = validateScriptPreflight(code);
  assert.ok(errors.some((error) => error.includes('Suspicious bare identifier value `Position`')));
});
