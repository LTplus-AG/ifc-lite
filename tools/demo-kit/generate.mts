#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Demo kit generator for the interactive walkthrough (tours) feature.
 *
 * Builds a small, neutral IFC4 model plus a derived revision, an IDS
 * ruleset, a viewer lens ruleset, and a manifest pinning the GlobalIds
 * and facts every tour references. Self-verifies every artifact against
 * the repo's own parser / IDS / clash / diff engines before declaring
 * success.
 *
 * Run from the repo root:
 *   pnpm tsx tools/demo-kit/generate.mts
 *
 * --- Why this file re-execs itself (see BOOTSTRAP below) -----------------
 * The repo root tsconfig.json maps a handful of `@ifc-lite/*` package
 * names (notably `@ifc-lite/ifcx`) to their `dist/index.d.ts` declaration
 * file for type-checking convenience. tsx's tsconfig-paths integration
 * resolves BARE `@ifc-lite/*` imports anywhere in the module graph (not
 * just this file's own imports) against the nearest tsconfig, and for a
 * `.d.ts` target it loads that declaration file AS the runtime module.
 * That round-trips fine for some packages but silently produces an
 * incomplete module for others — `@ifc-lite/ifcx` loses `detectFormat`,
 * `parseIfcx`, `parseFederatedIfcx`, `addIfcxOverlay` — which breaks
 * `@ifc-lite/parser`'s barrel (it re-exports from `@ifc-lite/ifcx`) the
 * moment anything imports it, including transitively via
 * `@ifc-lite/ids`'s bridge. Pointing `TSX_TSCONFIG_PATH` at the
 * alias-free `tools/demo-kit/tsconfig.json` for the whole process makes
 * every bare `@ifc-lite/*` specifier resolve via normal node_modules
 * symlinks instead, which are correct. This is a real, pre-existing repo
 * gotcha (not specific to this script) — flagged in the final report
 * rather than fixed at the root, since this task's scope is limited to
 * tools/demo-kit/ and apps/viewer/public/samples/.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const LOCAL_TSCONFIG = path.join(__dirname, 'tsconfig.json');

// ============================================================================
// BOOTSTRAP — re-exec once with TSX_TSCONFIG_PATH pinned (see file header)
// ============================================================================
if (!process.env.IFC_LITE_DEMO_KIT_BOOTSTRAPPED) {
  const { status } = spawnSync('pnpm', ['exec', 'tsx', __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: LOCAL_TSCONFIG,
      IFC_LITE_DEMO_KIT_BOOTSTRAPPED: '1',
    },
  });
  process.exit(status ?? 1);
}

// ============================================================================
// Imports (relative to packages/*/dist — see file header; bare
// `@ifc-lite/*` specifiers are avoided for our OWN imports on principle,
// even though the bootstrap above makes them safe transitively).
//
// These MUST be dynamic `import()` calls, not static top-level `import`
// statements: ES modules hoist static imports above ALL other code —
// including the bootstrap re-exec guard above, even though it appears
// first in the file — so a static import here would load the broken
// module graph before the guard ever gets a chance to run.
// ============================================================================
// Friendly clean-checkout guard: the imports below read built package
// output; on a fresh worktree dist/ does not exist yet and the raw import
// error is cryptic.
const REQUIRED_DIST = [
  'packages/create/dist/index.js',
  'packages/parser/dist/index.js',
  'packages/geometry/dist/index.js',
  'packages/diff/dist/index.js',
  'packages/clash/dist/index.js',
  'packages/ids/dist/index.js',
  'packages/encoding/dist/index.js',
];
const missingDist = REQUIRED_DIST.filter((p) => !existsSync(path.join(REPO_ROOT, p)));
if (missingDist.length > 0) {
  console.error('demo-kit: missing build output:\n  ' + missingDist.join('\n  '));
  console.error('\nBuild the workspace packages first, then re-run:\n  pnpm turbo build\n  pnpm tsx tools/demo-kit/generate.mts');
  process.exit(1);
}

const { IfcCreator } = await import('../../packages/create/dist/index.js');
const { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand } = await import('../../packages/parser/dist/index.js');
const { GeometryProcessor } = await import('../../packages/geometry/dist/index.js');
const { diffModels, buildDataFingerprint } = await import('../../packages/diff/dist/index.js');
const { createClashEngine, disciplineMatrixRules } = await import('../../packages/clash/dist/index.js');
const { elementsFromStep } = await import('../../packages/clash/dist/adapters/step.js');
const { parseIDS, auditIDSDocument, validateIDS } = await import('../../packages/ids/dist/index.js');
const { createDataAccessor } = await import('../../packages/ids/dist/bridge/index.js');
const { generateIfcGuid } = await import('../../packages/encoding/dist/index.js');

// Type-only: erased at runtime, so it does not bypass the bootstrap guard.
type Clash = import('../../packages/clash/dist/index.js').Clash;

type Point3D = [number, number, number];

const SAMPLES_DIR = path.join(REPO_ROOT, 'apps/viewer/public/samples');

// ============================================================================
// Small STEP-text editing utilities (used to derive revision B from the
// base bytes without regenerating — IfcCreator randomizes GlobalIds per
// run, and @ifc-lite/diff matches on GlobalId, so a regenerated file would
// diff as 100% added/deleted).
// ============================================================================

interface ParsedLine {
  type: string;
  args: string[];
  lineIndex: number;
}

/** Split a STEP argument list by top-level commas, respecting nested parens and quoted strings. */
function splitStepArgs(argsStr: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inString) {
      current += ch;
      if (ch === "'" && argsStr[i + 1] === "'") {
        current += "'";
        i++;
      } else if (ch === "'") {
        inString = false;
      }
    } else if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}

const STEP_LINE_RE = /^#(\d+)=([A-Z0-9_]+)\((.*)\);\s*$/;

/** Index every `#ID=TYPE(args);` data line in a STEP file (one entity per line, per IfcCreator's serializer). */
function buildIndex(lines: string[]): Map<number, ParsedLine> {
  const index = new Map<number, ParsedLine>();
  for (let i = 0; i < lines.length; i++) {
    const m = STEP_LINE_RE.exec(lines[i]);
    if (!m) continue;
    index.set(Number(m[1]), { type: m[2], args: splitStepArgs(m[3]), lineIndex: i });
  }
  return index;
}

function refId(arg: string): number | null {
  const m = /^#(\d+)$/.exec(arg.trim());
  return m ? Number(m[1]) : null;
}

function collectRefs(arg: string): number[] {
  const refs: number[] = [];
  const re = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg))) refs.push(Number(m[1]));
  return refs;
}

/** Forward-reachability closure: every entity transitively referenced from `seeds`. Safe (bounded) as long as
 *  seeds are leaf-ish product entities, since STEP placement/context chains terminate at `$`. */
function forwardClosure(index: Map<number, ParsedLine>, seeds: number[]): Set<number> {
  const seen = new Set<number>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const pl = index.get(id);
    if (!pl) continue;
    for (const arg of pl.args) {
      for (const r of collectRefs(arg)) {
        if (!seen.has(r)) stack.push(r);
      }
    }
  }
  return seen;
}

function requireLine(index: Map<number, ParsedLine>, id: number): ParsedLine {
  const pl = index.get(id);
  if (!pl) throw new Error(`STEP entity #${id} not found`);
  return pl;
}

function globalIdOf(index: Map<number, ParsedLine>, id: number): string {
  const pl = requireLine(index, id);
  const m = /^'([^']*)'$/.exec(pl.args[0]);
  if (!m) throw new Error(`entity #${id} has no GlobalId literal in arg[0]: ${pl.args[0]}`);
  return m[1];
}

function setLine(lines: string[], id: number, type: string, args: string[]): void {
  const idx = lines.findIndex((l) => new RegExp(`^#${id}=`).test(l));
  if (idx === -1) throw new Error(`cannot locate line for #${id} to rewrite`);
  lines[idx] = `#${id}=${type}(${args.join(',')});`;
}

// ============================================================================
// Geometry helpers
// ============================================================================

function dist3(a: Point3D, b: Point3D): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

// Material palette (RGB 0..1)
const CONCRETE: [number, number, number] = [0.65, 0.65, 0.62];
const STEEL: [number, number, number] = [0.55, 0.58, 0.62];
const BRICK: [number, number, number] = [0.55, 0.27, 0.18];
const GLASS: [number, number, number] = [0.65, 0.82, 0.9];
const GYPSUM: [number, number, number] = [0.92, 0.9, 0.83];

const FIRE_RATING_UNIQUE_BASE = 'REI60'; // exclusively on the wall that revision B upgrades — see deriveRevisionB
const FIRE_RATING_COMMON = 'REI90';

interface WallSpec {
  start: Point3D;
  end: Point3D;
  thickness: number;
  height: number;
  name: string;
  isExternal: boolean;
  fireRating?: string;
  objectType?: string;
}

/** Create a wall + Pset_WallCommon + Qto_WallBaseQuantities + material/color in one call. */
function addWall(creator: any, storeyId: number, spec: WallSpec): number {
  const wallId = creator.addIfcWall(storeyId, {
    Start: spec.start,
    End: spec.end,
    Thickness: spec.thickness,
    Height: spec.height,
    Name: spec.name,
    ObjectType: spec.objectType,
  });

  const properties: Array<{ Name: string; NominalValue: string | number | boolean; Type?: string }> = [
    { Name: 'IsExternal', NominalValue: spec.isExternal, Type: 'IfcBoolean' },
  ];
  if (spec.fireRating) properties.push({ Name: 'FireRating', NominalValue: spec.fireRating });
  creator.addIfcPropertySet(wallId, { Name: 'Pset_WallCommon', Properties: properties });

  const length = dist3(spec.start, spec.end);
  creator.addIfcElementQuantity(wallId, {
    Name: 'Qto_WallBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: length, Kind: 'IfcQuantityLength' },
      { Name: 'Width', Value: spec.thickness, Kind: 'IfcQuantityLength' },
      { Name: 'Height', Value: spec.height, Kind: 'IfcQuantityLength' },
      { Name: 'GrossFootprintArea', Value: length * spec.height, Kind: 'IfcQuantityArea' },
      { Name: 'NetVolume', Value: length * spec.height * spec.thickness, Kind: 'IfcQuantityVolume' },
    ],
  });

  const material = spec.isExternal ? 'Brick' : 'Gypsum';
  const color = spec.isExternal ? BRICK : GYPSUM;
  creator.addIfcMaterial(wallId, { Name: material, Category: 'Construction' });
  creator.setColor(wallId, material, color);

  return wallId;
}

/** Column + material/color + Qto_ColumnBaseQuantities + Pset_ColumnCommon in one call. */
function addColumn(creator: any, storeyId: number, position: Point3D, name: string): number {
  const colId = creator.addIfcColumn(storeyId, { Position: position, Width: 0.4, Depth: 0.4, Height: 3.0, Name: name });
  creator.addIfcMaterial(colId, { Name: 'Concrete', Category: 'Structural' });
  creator.setColor(colId, 'Concrete', CONCRETE);
  creator.addIfcElementQuantity(colId, {
    Name: 'Qto_ColumnBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: 3.0, Kind: 'IfcQuantityLength' },
      { Name: 'CrossSectionArea', Value: 0.16, Kind: 'IfcQuantityArea' },
    ],
  });
  creator.addIfcPropertySet(colId, { Name: 'Pset_ColumnCommon', Properties: [{ Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' }] });
  return colId;
}

// ============================================================================
// 1. Build the BASE model
// ============================================================================

interface BaseModel {
  content: string;
  ids: {
    storey1: number;
    storey2: number;
    wS: number; wE: number; wN: number; wW: number;
    wP1: number; wP2: number;
    w2S: number; w2E: number; w2N: number; w2W: number;
    w2P1: number; w2P2: number;
    doorMain: number; doorP1: number; doorP1L2: number;
    winE: number; winN: number;
    slab1: number; slab2: number; roof1: number;
    colC1: number; colC2: number; colC3: number;
    beam1: number; duct1: number; pipe1: number;
    spaceOffice101: number; spaceOffice102: number; spaceOpen201: number;
  };
}

function buildBaseModel(): BaseModel {
  const creator = new IfcCreator({ Name: 'Demo Project', Schema: 'IFC4', Organization: 'ifc-lite' });

  const storey1 = creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  const storey2 = creator.addIfcBuildingStorey({ Name: 'Level 2', Elevation: 3.0 });

  // --- Level 1: exterior walls (10m x 8m footprint, thickness 0.25, height 3.0) ---
  const wS = addWall(creator, storey1, {
    start: [0, 0, 0], end: [10, 0, 0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall South', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });
  const wE = addWall(creator, storey1, {
    start: [10, 0, 0], end: [10, 8, 0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall East', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });
  const wN = addWall(creator, storey1, {
    start: [10, 8, 0], end: [0, 8, 0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall North', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });
  const wW = addWall(creator, storey1, {
    start: [0, 8, 0], end: [0, 0, 0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall West', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });

  // --- Level 1: interior partitions ---
  // Partition P1 carries the UNIQUE fire rating that revision B upgrades (data-modified delta).
  const wP1 = addWall(creator, storey1, {
    start: [5, 0, 0], end: [5, 8, 0], thickness: 0.15, height: 3.0,
    name: 'Partition P1', isExternal: false, fireRating: FIRE_RATING_UNIQUE_BASE, objectType: 'InteriorWall',
  });
  // Partition P2 is the deliberate IDS gap (#1): no FireRating property at all.
  const wP2 = addWall(creator, storey1, {
    start: [7, 0, 0], end: [7, 3, 0], thickness: 0.15, height: 3.0,
    name: 'Partition P2', isExternal: false, objectType: 'InteriorWall',
  });

  // Openings: wall-hosted door + windows create real IfcOpeningElement + IfcRelFillsElement.
  const doorMain = creator.addIfcWallDoor(wS, { Position: [2, 0, 0], Width: 1.0, Height: 2.1, Name: 'Main Entrance' });
  const doorP1 = creator.addIfcWallDoor(wP1, { Position: [4, 0, 0], Width: 0.9, Height: 2.1, Name: 'Door P1' });
  const winE = creator.addIfcWallWindow(wE, { Position: [4, 0, 1.0], Width: 1.5, Height: 1.5, Name: 'Window E1' });
  const winN = creator.addIfcWallWindow(wN, { Position: [5, 0, 1.0], Width: 1.5, Height: 1.5, Name: 'Window N1' });
  creator.addIfcMaterial(winE, { Name: 'Glass' });
  creator.setColor(winE, 'Glass', GLASS);
  creator.addIfcMaterial(winN, { Name: 'Glass' });
  creator.setColor(winN, 'Glass', GLASS);
  creator.addIfcPropertySet(doorMain, { Name: 'Pset_DoorCommon', Properties: [{ Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' }, { Name: 'FireRating', NominalValue: FIRE_RATING_COMMON }] });
  creator.addIfcPropertySet(doorP1, { Name: 'Pset_DoorCommon', Properties: [{ Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' }] });
  creator.addIfcPropertySet(winE, { Name: 'Pset_WindowCommon', Properties: [{ Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' }, { Name: 'ThermalTransmittance', NominalValue: 1.1, Type: 'IfcReal' }] });
  creator.addIfcPropertySet(winN, { Name: 'Pset_WindowCommon', Properties: [{ Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' }, { Name: 'ThermalTransmittance', NominalValue: 1.1, Type: 'IfcReal' }] });

  // --- Level 1: floor slab ---
  const slab1 = creator.addIfcSlab(storey1, { Position: [0, 0, -0.2], Width: 10, Depth: 8, Thickness: 0.2, Name: 'Floor Slab L1' });
  creator.addIfcMaterial(slab1, { Name: 'Concrete', Category: 'Structural' });
  creator.setColor(slab1, 'Concrete', CONCRETE);

  // --- Level 1: columns (2-3 required; C1 gets its Name nulled post-hoc for the data-audit tour) ---
  const colC1 = addColumn(creator, storey1, [8, 2, 0], 'Column C1');
  // Column C2 is translated 0.5m in revision B (geometry-modified delta) — same GlobalId, same shape.
  const colC2 = addColumn(creator, storey1, [8, 6, 0], 'Column C2');
  const colC3 = addColumn(creator, storey1, [1.5, 6, 0], 'Column C3');

  // --- Level 1: beams (beam1 is the HARD CLASH target — see duct1 below) ---
  const beam1 = creator.addIfcBeam(storey1, { Start: [2, 1, 2.55], End: [2, 7, 2.55], Width: 0.3, Height: 0.5, Name: 'Beam B1' });
  creator.addIfcMaterial(beam1, { Name: 'Steel', Category: 'Structural' });
  creator.setColor(beam1, 'Steel', STEEL);
  creator.addIfcElementQuantity(beam1, {
    Name: 'Qto_BeamBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: 6.0, Kind: 'IfcQuantityLength' },
      { Name: 'CrossSectionArea', Value: 0.15, Kind: 'IfcQuantityArea' },
    ],
  });
  creator.addIfcPropertySet(beam1, { Name: 'Pset_BeamCommon', Properties: [{ Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' }] });

  // A second beam, clear of the duct/beam1 clash zone and every column footprint —
  // purely additional structural mass, not part of the pinned clash pair.
  const beam2 = creator.addIfcBeam(storey1, { Start: [4, 1, 2.55], End: [4, 7, 2.55], Width: 0.3, Height: 0.5, Name: 'Beam B2' });
  creator.addIfcMaterial(beam2, { Name: 'Steel', Category: 'Structural' });
  creator.setColor(beam2, 'Steel', STEEL);
  creator.addIfcElementQuantity(beam2, {
    Name: 'Qto_BeamBaseQuantities',
    Quantities: [
      { Name: 'Length', Value: 6.0, Kind: 'IfcQuantityLength' },
      { Name: 'CrossSectionArea', Value: 0.15, Kind: 'IfcQuantityArea' },
    ],
  });
  creator.addIfcPropertySet(beam2, { Name: 'Pset_BeamCommon', Properties: [{ Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' }] });

  // --- Level 1: stair to Level 2 (circulation element, clear of the MEP/beam clash zone) ---
  const stair1 = creator.addIfcStair(storey1, {
    Position: [5.6, 4.2, 0], Direction: 0,
    NumberOfRisers: 12, RiserHeight: 0.25, TreadLength: 0.28, Width: 1.2,
    Name: 'Stair to Level 2',
  });
  creator.addIfcMaterial(stair1, { Name: 'Concrete', Category: 'Structural' });
  creator.setColor(stair1, 'Concrete', CONCRETE);
  const stairRailing = creator.addIfcRailing(storey1, {
    Start: [5.6, 5.4, 0], End: [5.6 + 12 * 0.28, 5.4, 12 * 0.25],
    Height: 1.0, Width: 0.05, Name: 'Stair Railing',
  });
  creator.addIfcMaterial(stairRailing, { Name: 'Steel', Category: 'Fittings' });
  creator.setColor(stairRailing, 'Steel', STEEL);

  // --- Level 1: extra structural grid columns (safe distance from the MEP/beam clash zone) ---
  addColumn(creator, storey1, [1.5, 2, 0], 'Column C4');
  addColumn(creator, storey1, [4.5, 2, 0], 'Column C5');
  addColumn(creator, storey1, [4.5, 6.5, 0], 'Column C6');

  // --- Level 1: furnishing (desks, generic bounding boxes) ---
  const desk101 = creator.addIfcFurnishingElement(storey1, { Position: [1, 1, 0], Width: 1.4, Depth: 0.7, Height: 0.75, Name: 'Desk 101' });
  const desk102 = creator.addIfcFurnishingElement(storey1, { Position: [8.3, 1, 0], Width: 1.4, Depth: 0.7, Height: 0.75, Name: 'Desk 102' });
  for (const desk of [desk101, desk102]) {
    creator.addIfcPropertySet(desk, { Name: 'Pset_FurnitureTypeCommon', Properties: [{ Name: 'AssemblyPlace', NominalValue: 'FACTORY' }] });
  }

  // --- Foundations (deep underground, well clear of the MEP/beam clash zone) ---
  const footingC1 = creator.addIfcFooting(storey1, { Position: [8, 2, -0.2], Width: 0.6, Depth: 0.6, Height: 0.6, Name: 'Footing F1', PredefinedType: 'PAD_FOOTING' });
  const footingC3 = creator.addIfcFooting(storey1, { Position: [1.5, 6, -0.2], Width: 0.6, Depth: 0.6, Height: 0.6, Name: 'Footing F3', PredefinedType: 'PAD_FOOTING' });
  for (const footing of [footingC1, footingC3]) {
    creator.addIfcMaterial(footing, { Name: 'Concrete', Category: 'Structural' });
    creator.setColor(footing, 'Concrete', CONCRETE);
    creator.addIfcPropertySet(footing, { Name: 'Pset_FootingCommon', Properties: [{ Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' }] });
    creator.addIfcElementQuantity(footing, {
      Name: 'Qto_FootingBaseQuantities',
      Quantities: [
        { Name: 'Length', Value: 0.6, Kind: 'IfcQuantityLength' },
        { Name: 'Width', Value: 0.6, Kind: 'IfcQuantityLength' },
        { Name: 'Height', Value: 0.6, Kind: 'IfcQuantityLength' },
      ],
    });
  }

  // --- Level 1: MEP ---
  // Duct crosses fully through beam1's footprint (x: 1.85-2.15) with its top 90mm poking
  // into the beam's bottom 90mm (beam z: 2.30-2.80, duct z: 2.09-2.39) — a real, well-above-
  // tolerance hard clash (2mm default), never a coplanar/flush-face touch.
  const duct1 = creator.addAxisElement(storey1, {
    IfcType: 'IFCDUCTSEGMENT',
    Start: [0.5, 4, 2.24], End: [3.5, 4, 2.24],
    Profile: { ProfileType: 'AREA', Radius: 0.15 },
    Name: 'Duct D1', PredefinedType: 'RIGIDSEGMENT',
  });
  creator.addIfcMaterial(duct1, { Name: 'Steel', Category: 'MEP' });
  creator.setColor(duct1, 'Steel', STEEL);

  // Pipe runs parallel to the west wall's inner face with an exact 15mm clearance gap
  // (west wall centreline x=0, thickness 0.25 -> inner face x=0.125; pipe radius 0.04,
  // centreline x=0.18 -> pipe surface x=0.14 -> gap = 0.14 - 0.125 = 0.015m). Near miss,
  // never touching.
  const pipe1 = creator.addAxisElement(storey1, {
    IfcType: 'IFCPIPESEGMENT',
    Start: [0.18, 1, 1.0], End: [0.18, 7, 1.0],
    Profile: { ProfileType: 'AREA', Radius: 0.04 },
    Name: 'Pipe P1', PredefinedType: 'RIGIDSEGMENT',
  });
  creator.addIfcMaterial(pipe1, { Name: 'Steel', Category: 'MEP' });
  creator.setColor(pipe1, 'Steel', STEEL);

  // --- Level 1: spaces (both MUST have Name — IDS spec 3 checks this) ---
  const spaceOffice101 = creator.addIfcSpace(storey1, { Position: [0.2, 0.2, 0], Width: 4.6, Depth: 7.6, Height: 3.0, Name: 'Office 101', LongName: 'Office 101' });
  const spaceOffice102 = creator.addIfcSpace(storey1, { Position: [5.2, 0.2, 0], Width: 4.6, Depth: 7.6, Height: 3.0, Name: 'Office 102', LongName: 'Office 102' });
  for (const space of [spaceOffice101, spaceOffice102]) {
    creator.addIfcPropertySet(space, { Name: 'Pset_SpaceCommon', Properties: [{ Name: 'PubliclyAccessible', NominalValue: false, Type: 'IfcBoolean' }] });
    creator.addIfcElementQuantity(space, {
      Name: 'Qto_SpaceBaseQuantities',
      Quantities: [
        { Name: 'NetFloorArea', Value: 4.6 * 7.6, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: 4.6 * 7.6 * 3.0, Kind: 'IfcQuantityVolume' },
      ],
    });
  }

  // --- Level 2: exterior walls ---
  const w2S = addWall(creator, storey2, {
    start: [0, 0, 3.0], end: [10, 0, 3.0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall South (L2)', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });
  const w2E = addWall(creator, storey2, {
    start: [10, 0, 3.0], end: [10, 8, 3.0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall East (L2)', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });
  const w2N = addWall(creator, storey2, {
    start: [10, 8, 3.0], end: [0, 8, 3.0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall North (L2)', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });
  const w2W = addWall(creator, storey2, {
    start: [0, 8, 3.0], end: [0, 0, 3.0], thickness: 0.25, height: 3.0,
    name: 'Exterior Wall West (L2)', isExternal: true, fireRating: FIRE_RATING_COMMON, objectType: 'ExteriorWall',
  });

  // --- Level 2: interior partitions ---
  const w2P1 = addWall(creator, storey2, {
    start: [5, 0, 3.0], end: [5, 8, 3.0], thickness: 0.15, height: 3.0,
    name: 'Partition P1 (L2)', isExternal: false, fireRating: FIRE_RATING_COMMON, objectType: 'InteriorWall',
  });
  // Deliberate IDS gap (#2): no FireRating.
  const w2P2 = addWall(creator, storey2, {
    start: [7, 0, 3.0], end: [7, 3, 3.0], thickness: 0.15, height: 3.0,
    name: 'Partition P2 (L2)', isExternal: false, objectType: 'InteriorWall',
  });

  // Interior door on Level 2 — this one is DELETED in revision B.
  const doorP1L2 = creator.addIfcWallDoor(w2P1, { Position: [4, 0, 0], Width: 0.9, Height: 2.1, Name: 'Door P1 (L2)' });
  creator.addIfcPropertySet(doorP1L2, { Name: 'Pset_DoorCommon', Properties: [{ Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' }] });

  // Windows on Level 2, mirroring Level 1.
  const winE2 = creator.addIfcWallWindow(w2E, { Position: [4, 0, 1.0], Width: 1.5, Height: 1.5, Name: 'Window E1 (L2)' });
  const winN2 = creator.addIfcWallWindow(w2N, { Position: [5, 0, 1.0], Width: 1.5, Height: 1.5, Name: 'Window N1 (L2)' });
  for (const win of [winE2, winN2]) {
    creator.addIfcMaterial(win, { Name: 'Glass' });
    creator.setColor(win, 'Glass', GLASS);
    creator.addIfcPropertySet(win, { Name: 'Pset_WindowCommon', Properties: [{ Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' }, { Name: 'ThermalTransmittance', NominalValue: 1.1, Type: 'IfcReal' }] });
  }

  // --- Level 2: floor slab + roof ---
  const slab2 = creator.addIfcSlab(storey2, { Position: [0, 0, 2.8], Width: 10, Depth: 8, Thickness: 0.2, Name: 'Floor Slab L2' });
  creator.addIfcMaterial(slab2, { Name: 'Concrete', Category: 'Structural' });
  creator.setColor(slab2, 'Concrete', CONCRETE);
  for (const slab of [slab1, slab2]) {
    creator.addIfcPropertySet(slab, { Name: 'Pset_SlabCommon', Properties: [{ Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' }, { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' }] });
    creator.addIfcElementQuantity(slab, {
      Name: 'Qto_SlabBaseQuantities',
      Quantities: [
        { Name: 'GrossArea', Value: 10 * 8, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: 10 * 8 * 0.2, Kind: 'IfcQuantityVolume' },
      ],
    });
  }

  // Roof's Name is nulled post-hoc (mixed data quality — see nullifyName below).
  const roof1 = creator.addIfcRoof(storey2, { Position: [0, 0, 6.0], Width: 10, Depth: 8, Thickness: 0.2, Slope: 0, Name: 'Roof' });
  creator.addIfcMaterial(roof1, { Name: 'Concrete', Category: 'Structural' });
  creator.setColor(roof1, 'Concrete', CONCRETE);
  creator.addIfcPropertySet(roof1, { Name: 'Pset_RoofCommon', Properties: [{ Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' }] });

  // --- Level 2: extra structural grid columns (mirrors Level 1; no MEP up here so placement is unconstrained) ---
  addColumn(creator, storey2, [8, 2, 3.0], 'Column C1 (L2)');
  addColumn(creator, storey2, [8, 6, 3.0], 'Column C2 (L2)');
  addColumn(creator, storey2, [1.5, 6, 3.0], 'Column C3 (L2)');

  // --- Level 2: space ---
  const spaceOpen201 = creator.addIfcSpace(storey2, { Position: [0.2, 0.2, 3.0], Width: 9.6, Depth: 7.6, Height: 3.0, Name: 'Open Area 201', LongName: 'Open Area 201' });
  creator.addIfcPropertySet(spaceOpen201, { Name: 'Pset_SpaceCommon', Properties: [{ Name: 'PubliclyAccessible', NominalValue: true, Type: 'IfcBoolean' }] });
  creator.addIfcElementQuantity(spaceOpen201, {
    Name: 'Qto_SpaceBaseQuantities',
    Quantities: [
      { Name: 'NetFloorArea', Value: 9.6 * 7.6, Kind: 'IfcQuantityArea' },
      { Name: 'GrossVolume', Value: 9.6 * 7.6 * 3.0, Kind: 'IfcQuantityVolume' },
    ],
  });

  // Furnishing on Level 2 (generic bounding boxes, purely additional mass).
  const desk201 = creator.addIfcFurnishingElement(storey2, { Position: [1, 1, 3.0], Width: 1.4, Depth: 0.7, Height: 0.75, Name: 'Desk 201' });
  const desk202 = creator.addIfcFurnishingElement(storey2, { Position: [8, 1, 3.0], Width: 1.4, Depth: 0.7, Height: 0.75, Name: 'Desk 202' });
  for (const desk of [desk201, desk202]) {
    creator.addIfcPropertySet(desk, { Name: 'Pset_FurnitureTypeCommon', Properties: [{ Name: 'AssemblyPlace', NominalValue: 'FACTORY' }] });
  }

  const { content } = creator.toIfc();

  return {
    content,
    ids: {
      storey1, storey2,
      wS, wE, wN, wW, wP1, wP2,
      w2S, w2E, w2N, w2W, w2P1, w2P2,
      doorMain, doorP1, doorP1L2,
      winE, winN,
      slab1, slab2, roof1,
      colC1, colC2, colC3,
      beam1, duct1, pipe1,
      spaceOffice101, spaceOffice102, spaceOpen201,
    },
  };
}

/** Blank a IfcRoot entity's Name (index 2) to `$`, in place — used for the "missing Name" data-quality gaps. */
function nullifyName(lines: string[], index: Map<number, ParsedLine>, id: number): void {
  const pl = requireLine(index, id);
  const args = [...pl.args];
  args[2] = '$';
  setLine(lines, id, pl.type, args);
}

// ============================================================================
// 2. Derive revision B from the BASE bytes (never regenerate — see file header)
// ============================================================================

interface RevisionBResult {
  content: string;
  addedWallGlobalId: string;
}

function buildAddedWallFragment(
  baseMaxId: number,
  storey2Id: number,
  baseOwnerHistoryId: number,
): { lines: string[]; wallGlobalId: string } {
  // A throwaway IfcCreator authors the new wall with correct STEP grammar. Its own
  // project/site/building/storey are never harvested (nothing in the wall's forward
  // closure reaches them — placement chains terminate at `$`, shape reps terminate at
  // the geometric context), so only the wall's true dependency subtree gets spliced in.
  const creator2 = new IfcCreator({ Name: 'Demo Project', Schema: 'IFC4' });
  const scratchStorey = creator2.addIfcBuildingStorey({ Name: 'Level 2', Elevation: 3.0 });
  const wallId = creator2.addIfcWall(scratchStorey, {
    Start: [3, 0, 3.0], End: [3, 3, 3.0], Thickness: 0.15, Height: 3.0,
    Name: 'Partition P3 (L2)', ObjectType: 'InteriorWall',
  });
  const psetId = creator2.addIfcPropertySet(wallId, {
    Name: 'Pset_WallCommon',
    Properties: [
      { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
      { Name: 'FireRating', NominalValue: FIRE_RATING_COMMON },
    ],
  });
  const { content: addonContent } = creator2.toIfc();
  const addonLines = addonContent.split('\n');
  const addonIndex = buildIndex(addonLines);

  let relDefId: number | null = null;
  for (const [id, pl] of addonIndex) {
    if (pl.type === 'IFCRELDEFINESBYPROPERTIES') {
      relDefId = id;
      break;
    }
  }
  if (relDefId === null) throw new Error('addon fragment: IFCRELDEFINESBYPROPERTIES not found');

  const closure = forwardClosure(addonIndex, [wallId, psetId, relDefId]);
  const shift = baseMaxId + 10;

  const remapArg = (arg: string): string =>
    arg.replace(/#(\d+)/g, (whole, digits) => {
      const n = Number(digits);
      return closure.has(n) ? `#${n + shift}` : whole;
    });

  const harvestLines: string[] = [];
  for (const id of closure) {
    const pl = addonIndex.get(id)!;
    harvestLines.push(`#${id + shift}=${pl.type}(${pl.args.map(remapArg).join(',')});`);
  }

  const shiftedWallId = wallId + shift;
  // Above every harvested id: closure ids are a sparse SUBSET of the addon
  // doc's numbering, so `shift + closure.size + 1` can collide with a
  // harvested `id + shift` (it did - duplicate #1246 in an earlier kit).
  const containRelId = shift + Math.max(...closure) + 1;
  const containGuid = generateIfcGuid();
  harvestLines.push(
    `#${containRelId}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${containGuid}',#${baseOwnerHistoryId},$,$,(#${shiftedWallId}),#${storey2Id});`,
  );

  return { lines: harvestLines, wallGlobalId: globalIdOf(addonIndex, wallId) };
}

function deriveRevisionB(baseContent: string, base: BaseModel['ids']): RevisionBResult {
  // 1) DATA-MODIFIED: bump wP1's FireRating. The base model gives wP1 a value used
  //    NOWHERE else in the file, so this plain string swap is unambiguous.
  const content = baseContent.replace(`IFCLABEL('${FIRE_RATING_UNIQUE_BASE}')`, `IFCLABEL('${FIRE_RATING_COMMON}')`);
  if (content === baseContent) throw new Error('revB: unique FireRating literal not found in base content');

  let lines = content.split('\n');
  let index = buildIndex(lines);

  // 2) GEOMETRY-MODIFIED: translate colC2 by +0.5m along X via its placement's CartesianPoint.
  //    Same GlobalId, same shape/dimensions — only the world position changes.
  {
    const colArgs = requireLine(index, base.colC2).args;
    const placementId = refId(colArgs[5])!;
    const placementArgs = requireLine(index, placementId).args;
    const axis2Id = refId(placementArgs[1])!;
    const axis2Args = requireLine(index, axis2Id).args;
    const pointId = refId(axis2Args[0])!;
    const pointLine = requireLine(index, pointId);
    const coords = pointLine.args[0].slice(1, -1).split(',').map((s) => parseFloat(s));
    coords[0] += 0.5;
    const newCoords = `(${coords.map((v) => (Number.isInteger(v) ? `${v}.` : String(v))).join(',')})`;
    setLine(lines, pointId, 'IFCCARTESIANPOINT', [newCoords]);
  }
  index = buildIndex(lines);

  // 3) DELETED: the Level 2 interior door + its IfcRelFillsElement. The opening it filled
  //    is deliberately left in place (a door removed, void remains).
  {
    const doorLineIdx = requireLine(index, base.doorP1L2).lineIndex;
    let relFillsLineIdx: number | null = null;
    for (const [, pl] of index) {
      if (pl.type === 'IFCRELFILLSELEMENT' && refId(pl.args[5]) === base.doorP1L2) {
        relFillsLineIdx = pl.lineIndex;
        break;
      }
    }
    if (relFillsLineIdx === null) throw new Error('revB: IFCRELFILLSELEMENT for deleted door not found');
    const drop = new Set([doorLineIdx, relFillsLineIdx]);
    lines = lines.filter((_, i) => !drop.has(i));

    // Scrub every remaining reference to the deleted door: other rels
    // (property sets, spatial containment, type/material bindings) still
    // point at it, which corrupts the STEP file with dangling references
    // (it did - #896 in an earlier kit). Remove the door from aggregate
    // lists; a rel whose related-objects list becomes empty is meaningless
    // and is dropped whole.
    const doorId = base.doorP1L2;
    const doorRef = new RegExp(`#${doorId}(?![0-9])`);
    lines = lines.flatMap((line) => {
      if (!doorRef.test(line)) return [line];
      const scrubbed = line
        .replace(new RegExp(`#${doorId}(?![0-9]),`, 'g'), '')
        .replace(new RegExp(`,#${doorId}(?![0-9])`, 'g'), '')
        .replace(new RegExp(`\\(#${doorId}(?![0-9])\\)`, 'g'), '()');
      if (scrubbed.includes('()')) return []; // sole member - drop the rel
      if (doorRef.test(scrubbed)) {
        throw new Error(`revB: unhandled reference to deleted door: ${line.slice(0, 100)}`);
      }
      return [scrubbed];
    });
  }
  index = buildIndex(lines);

  // 4) ADDED: splice in a brand-new partition wall (fresh GlobalId) on Level 2.
  let baseMaxId = 0;
  for (const id of index.keys()) if (id > baseMaxId) baseMaxId = id;

  let ownerHistoryId: number | null = null;
  for (const [id, pl] of index) {
    if (pl.type === 'IFCOWNERHISTORY') {
      ownerHistoryId = id;
      break;
    }
  }
  if (ownerHistoryId === null) throw new Error('revB: base IFCOWNERHISTORY not found');

  const { lines: addedLines, wallGlobalId } = buildAddedWallFragment(baseMaxId, base.storey2, ownerHistoryId);

  const endsecIdx = lines.lastIndexOf('ENDSEC;');
  if (endsecIdx === -1) throw new Error('revB: closing ENDSEC; not found');
  lines.splice(endsecIdx, 0, ...addedLines);

  return { content: lines.join('\n'), addedWallGlobalId: wallGlobalId };
}

// ============================================================================
// 3. IDS document
// ============================================================================

function buildIdsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info>
    <title>Demo Project IDS</title>
    <description>Sample buildingSMART IDS specifications for the ifc-lite interactive tour demo kit.</description>
    <author>ifc-lite</author>
  </info>
  <specifications>
    <specification name="Walls declare IsExternal" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
        </entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>IsExternal</simpleValue></baseName>
        </property>
      </requirements>
    </specification>
    <specification name="Walls have a fire rating" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
        </entity>
      </applicability>
      <requirements>
        <property>
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
        </property>
      </requirements>
    </specification>
    <specification name="Spaces are named" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCSPACE</simpleValue></name>
        </entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>
`;
}

// ============================================================================
// 4. Viewer lens ruleset
// ============================================================================

function buildLensesJson(): unknown[] {
  return [
    {
      id: 'demo-fire-safety',
      name: 'Fire safety',
      rules: [
        {
          id: 'fire-rated-green',
          name: 'Fire-rated walls',
          enabled: true,
          criteria: { type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'exists' },
          action: 'colorize',
          color: '#43A047',
        },
        {
          id: 'no-fire-rating-red',
          name: 'Walls (no fire rating)',
          enabled: true,
          criteria: { type: 'ifcType', ifcType: 'IfcWall' },
          action: 'colorize',
          color: '#E53935',
        },
        {
          id: 'spaces-transparent',
          name: 'Spaces',
          enabled: true,
          criteria: { type: 'ifcType', ifcType: 'IfcSpace' },
          action: 'transparent',
          color: '#FFFFFF',
        },
      ],
    },
  ];
}

// ============================================================================
// Verification helpers
// ============================================================================

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

/** Suppress the parser's/geometry pipeline's chatty console.log during headless use. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
  }
}

interface Fingerprint {
  key: string;
  ifcType: string;
  dataHash: string;
  geometryHash: bigint | undefined;
  ref: number;
}

function extractPropertiesOnDemandSafe(store: any, id: number) {
  return extractPropertiesOnDemand(store, id).map((set: any) => ({
    name: set.name,
    properties: set.properties.map((p: any) => ({ name: p.name, value: p.value })),
  }));
}
function extractQuantitiesOnDemandSafe(store: any, id: number) {
  return extractQuantitiesOnDemand(store, id).map((set: any) => ({
    name: set.name,
    quantities: set.quantities.map((q: any) => ({ name: q.name, value: q.value })),
  }));
}

function buildFingerprints(store: any, meshes: any[]): Fingerprint[] {
  const geometryByLocalId = new Map<number, bigint | undefined>();
  for (const mesh of meshes) {
    if (!geometryByLocalId.has(mesh.expressId)) geometryByLocalId.set(mesh.expressId, mesh.geometryHash);
  }
  const fingerprints: Fingerprint[] = [];
  for (const [id, geometryHash] of geometryByLocalId) {
    const ifcType = store.entities.getTypeName(id) || 'IfcProduct';
    const globalId = store.entities.getGlobalId(id);
    const key = globalId || `missing:${id}`;

    const propertySets = extractPropertiesOnDemandSafe(store, id);
    const quantitySets = extractQuantitiesOnDemandSafe(store, id);

    fingerprints.push({
      key,
      ifcType,
      dataHash: buildDataFingerprint({
        ifcType,
        name: store.entities.getName(id) || undefined,
        description: store.entities.getDescription(id) || undefined,
        objectType: store.entities.getObjectType(id) || undefined,
        propertySets,
        quantitySets,
        typeAssignments: [],
      }),
      geometryHash,
      ref: id,
    });
  }
  return fingerprints;
}

async function parseStore(bytes: Uint8Array): Promise<any> {
  return quiet(async () => {
    const parser = new IfcParser();
    return parser.parseColumnar(bytes.buffer as ArrayBuffer);
  });
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  await mkdir(SAMPLES_DIR, { recursive: true });

  console.log('Building base model...');
  const base = buildBaseModel();

  // Mixed data quality: null out Name on two elements neither pinned by any check.
  // This MUST happen before deriving revision B — colC1 and roof1 are unchanged
  // entities shared by both revisions, so both sides need the identical (nulled)
  // Name, or the diff would spuriously flag them as data-modified.
  const baseLines = base.content.split('\n');
  const baseIndexForNulling = buildIndex(baseLines);
  nullifyName(baseLines, baseIndexForNulling, base.ids.colC1);
  nullifyName(baseLines, baseIndexForNulling, base.ids.roof1);
  const finalBaseContent = baseLines.join('\n');
  const finalBaseIndex = buildIndex(baseLines);

  console.log('Deriving revision B from base bytes...');
  const revB = deriveRevisionB(finalBaseContent, base.ids);

  const pins = {
    fireRatingGapWalls: [globalIdOf(finalBaseIndex, base.ids.wP2), globalIdOf(finalBaseIndex, base.ids.w2P2)],
    clashDuct: globalIdOf(finalBaseIndex, base.ids.duct1),
    clashBeam: globalIdOf(finalBaseIndex, base.ids.beam1),
    clearancePipe: globalIdOf(finalBaseIndex, base.ids.pipe1),
    movedColumn: globalIdOf(finalBaseIndex, base.ids.colC2),
    addedWall: revB.addedWallGlobalId,
    deletedDoor: globalIdOf(finalBaseIndex, base.ids.doorP1L2),
    dataModifiedWall: globalIdOf(finalBaseIndex, base.ids.wP1),
  };

  const idsXml = buildIdsXml();
  const lensesJson = buildLensesJson();
  const manifest = {
    version: 1,
    base: 'samples/demo-project.ifc',
    revB: 'samples/demo-project-rev-b.ifc',
    ids: 'samples/demo-project.ids',
    lenses: 'samples/demo-project.lenses.json',
    globalIds: pins,
    facts: {
      storeys: ['Level 1', 'Level 2'],
      searchTerm: 'door',
      clashPair: 'duct vs beam',
    },
  };

  const files = {
    'demo-project.ifc': finalBaseContent,
    'demo-project-rev-b.ifc': revB.content,
    'demo-project.ids': idsXml,
    'demo-project.lenses.json': JSON.stringify(lensesJson, null, 2),
    'demo-kit.json': JSON.stringify(manifest, null, 2),
  };

  console.log('Writing artifacts to apps/viewer/public/samples/...');
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(SAMPLES_DIR, name), content, 'utf-8');
  }

  // ==========================================================================
  // Self-verification
  // ==========================================================================
  console.log('Running self-verification...\n');

  const baseBytesOnDisk = new Uint8Array(await readFile(path.join(SAMPLES_DIR, 'demo-project.ifc')));
  const revBBytesOnDisk = new Uint8Array(await readFile(path.join(SAMPLES_DIR, 'demo-project-rev-b.ifc')));

  // --- 1. Parse cleanly ---
  let baseStore: any;
  let revBStore: any;
  try {
    baseStore = await parseStore(baseBytesOnDisk);
    check('parse.base', baseStore.entityCount > 0, `base parsed: ${baseStore.entityCount} entities`);
  } catch (err) {
    check('parse.base', false, `threw: ${(err as Error).message}`);
  }
  try {
    revBStore = await parseStore(revBBytesOnDisk);
    check('parse.revB', revBStore.entityCount > 0, `revB parsed: ${revBStore.entityCount} entities`);
  } catch (err) {
    check('parse.revB', false, `threw: ${(err as Error).message}`);
  }

  // --- 2. IDS ---
  try {
    const idsText = await readFile(path.join(SAMPLES_DIR, 'demo-project.ids'), 'utf-8');
    const audit = await auditIDSDocument(idsText);
    check('ids.audit', audit.status !== 'error', `audit status=${audit.status}, issues=${audit.issues.length}`);

    const doc = parseIDS(idsText);
    const accessor = createDataAccessor(baseStore);
    const report = await validateIDS(doc, accessor, { schemaVersion: baseStore.schemaVersion }, { includePassingEntities: true });

    const [spec1, spec2, spec3] = report.specificationResults;
    check('ids.spec1.allPass', spec1.failedCount === 0 && spec1.applicableCount > 0,
      `Walls declare IsExternal: ${spec1.passedCount}/${spec1.applicableCount} passed`);

    const failedGlobalIds = spec2.entityResults.filter((r: any) => !r.passed).map((r: any) => r.globalId).sort();
    const expectedGapIds = [...pins.fireRatingGapWalls].sort();
    check('ids.spec2.exactlyTwoGaps', spec2.failedCount === 2 && JSON.stringify(failedGlobalIds) === JSON.stringify(expectedGapIds),
      `Walls have a fire rating: ${spec2.failedCount} failing (expected 2), globalIds=${JSON.stringify(failedGlobalIds)}`);

    check('ids.spec3.allPass', spec3.failedCount === 0 && spec3.applicableCount > 0,
      `Spaces are named: ${spec3.passedCount}/${spec3.applicableCount} passed`);
  } catch (err) {
    check('ids.validation', false, `threw: ${(err as Error).message}`);
  }

  // --- Mesh both models once (shared by clash + diff checks) ---
  const processor = new GeometryProcessor();
  await processor.init();
  processor.enableGeometryHashes();
  const { meshes: baseMeshes } = await processor.process(baseBytesOnDisk);
  const { meshes: revBMeshes } = await processor.process(revBBytesOnDisk);

  // --- 3. Clash ---
  try {
    const { elements, exclusions } = elementsFromStep({ store: baseStore, meshes: baseMeshes, modelId: 'base' });
    const engine = createClashEngine({ backend: 'ts' });
    const clashResult = await engine.run(elements, disciplineMatrixRules('hard'), { exclusions });

    const pinnedPair = clashResult.clashes.find((c: Clash) =>
      c.status === 'hard' &&
      ((c.a.key === pins.clashDuct && c.b.key === pins.clashBeam) ||
        (c.a.key === pins.clashBeam && c.b.key === pins.clashDuct)));

    check('clash.pinnedPairPresent', !!pinnedPair,
      pinnedPair ? `found duct-vs-beam hard clash, distance=${pinnedPair.distance.toFixed(4)}m` : 'pinned duct/beam pair NOT found');
    check('clash.countBounded', clashResult.summary.total <= 20,
      `total clashes=${clashResult.summary.total} (<=20 required)`);
  } catch (err) {
    check('clash.run', false, `threw: ${(err as Error).message}`);
  }

  // --- 4. Diff ---
  try {
    const baseFps = buildFingerprints(baseStore, baseMeshes);
    const revBFps = buildFingerprints(revBStore, revBMeshes);
    const modelDiff = diffModels(baseFps, revBFps, { scope: 'both' });

    check('diff.counts', modelDiff.counts.added === 1 && modelDiff.counts.deleted === 1 && modelDiff.counts.modified === 2,
      `added=${modelDiff.counts.added} deleted=${modelDiff.counts.deleted} modified=${modelDiff.counts.modified} unchanged=${modelDiff.counts.unchanged}`);

    const addedEntry = modelDiff.byKey.get(pins.addedWall);
    check('diff.added.matchesPin', addedEntry?.state === 'added', `addedWall entry state=${addedEntry?.state}`);

    const deletedEntry = modelDiff.byKey.get(pins.deletedDoor);
    check('diff.deleted.matchesPin', deletedEntry?.state === 'deleted', `deletedDoor entry state=${deletedEntry?.state}`);

    const dataEntry = modelDiff.byKey.get(pins.dataModifiedWall);
    check('diff.dataModified.matchesPin',
      dataEntry?.state === 'modified' && JSON.stringify(dataEntry.changeKinds) === JSON.stringify(['data']),
      `dataModifiedWall entry state=${dataEntry?.state} changeKinds=${JSON.stringify(dataEntry?.changeKinds)}`);

    const geomEntry = modelDiff.byKey.get(pins.movedColumn);
    check('diff.geometryModified.matchesPin',
      geomEntry?.state === 'modified' && JSON.stringify(geomEntry.changeKinds) === JSON.stringify(['geometry']),
      `movedColumn entry state=${geomEntry?.state} changeKinds=${JSON.stringify(geomEntry?.changeKinds)}`);
  } catch (err) {
    check('diff.run', false, `threw: ${(err as Error).message}`);
  }

  // --- 5. Total artifact size ---
  const sizes = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, Buffer.byteLength(content, 'utf-8')]),
  );
  const totalBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
  check('size.totalBudget', totalBytes <= 300 * 1024, `total=${(totalBytes / 1024).toFixed(1)}KB (<=300KB required)`);

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('\nFile sizes:');
  for (const [name, bytes] of Object.entries(sizes)) {
    console.log(`  ${name.padEnd(28)} ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
  console.log(`  ${'TOTAL'.padEnd(28)} ${(totalBytes / 1024).toFixed(1).padStart(8)} KB`);

  console.log('\nPinned GlobalIds:');
  for (const [k, v] of Object.entries(pins)) {
    console.log(`  ${k.padEnd(20)} ${Array.isArray(v) ? v.join(', ') : v}`);
  }

  console.log('\nVerification results:');
  let allPass = true;
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name.padEnd(32)} ${r.detail}`);
  }

  console.log(`\n${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
  if (!allPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('demo-kit generate failed:', err);
  process.exitCode = 1;
});
