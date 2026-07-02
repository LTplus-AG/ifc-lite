#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Demo kit VARIANT DERIVER for the interactive walkthrough (tours) feature.
 *
 * Supersedes the old fully-synthetic `generate.mts` (which authored a whole
 * model with `IfcCreator`). The tours now demo on the REAL committed sample
 * `apps/viewer/public/samples/building-architecture.ifc` (buildingSMART "ifc
 * silly sample scene") — compare and clash still need authored content that
 * base lacks, so this script DERIVES small variants from the base bytes
 * (GlobalId-preserved) instead of generating a whole model. It never
 * modifies the base file itself.
 *
 * Produces:
 *   - building-architecture-rev-b.ifc  (4 compare deltas + 1 injected hard clash)
 *   - building-architecture.ids        (mixed pass/fail IDS 1.0 ruleset, vs BASE)
 *   - demo-kit.json                    (manifest pinning every GlobalId/fact)
 *
 * Run from the repo root:
 *   pnpm tsx tools/demo-kit/derive-variants.mts
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
import { writeFile, readFile } from 'node:fs/promises';

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
  console.error('\nBuild the workspace packages first, then re-run:\n  pnpm turbo build\n  pnpm tsx tools/demo-kit/derive-variants.mts');
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

const SAMPLES_DIR = path.join(REPO_ROOT, 'apps/viewer/public/samples');
const BASE_FILE = path.join(SAMPLES_DIR, 'building-architecture.ifc');
const REV_B_FILE = path.join(SAMPLES_DIR, 'building-architecture-rev-b.ifc');
const IDS_FILE = path.join(SAMPLES_DIR, 'building-architecture.ids');
const MANIFEST_FILE = path.join(SAMPLES_DIR, 'demo-kit.json');

// ============================================================================
// STEP-text editing utilities — lifted verbatim from the old generate.mts
// (`git show HEAD:tools/demo-kit/generate.mts`), including its two proven
// bug fixes: on DELETE, scrub every dangling reference to the removed
// entity and drop any rel whose RelatedObjects list becomes empty; on ADD,
// allocate new instance ids above `max(closure) + shift`, never by
// `closure.size` (a sparse id subset can collide with a shifted id — it did,
// duplicate #1246 in an earlier kit).
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

/** Index every `#ID=TYPE(args);` data line in a STEP file (one entity per line). */
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

/** Forward-reachability closure: every entity transitively referenced from `seeds`. */
function forwardClosure(index: Map<number, ParsedLine>, seeds: number[]): Set<number> {
  return forwardClosureExcluding(index, seeds, EMPTY_EXCLUSION);
}

const EMPTY_EXCLUSION: ReadonlySet<number> = new Set();

/**
 * Forward-reachability closure that never traverses INTO `excluded` ids (they
 * are dropped from the result, and edges pointing at them are not followed).
 * Used to sever one specific edge (e.g. a scratch document's own identity
 * placement) without discarding OTHER entities that happen to be reachable
 * via a different edge — some IfcCreator entities are shared/cached (e.g.
 * the default extrusion direction reuses the same IfcDirection as the
 * world placement's Z axis), so blindly subtracting a whole descendant
 * closure would remove leaves that are still legitimately needed elsewhere.
 */
function forwardClosureExcluding(
  index: Map<number, ParsedLine>,
  seeds: number[],
  excluded: ReadonlySet<number>,
): Set<number> {
  const seen = new Set<number>();
  const stack = seeds.filter((s) => !excluded.has(s));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id) || excluded.has(id)) continue;
    seen.add(id);
    const pl = index.get(id);
    if (!pl) continue;
    for (const arg of pl.args) {
      for (const r of collectRefs(arg)) {
        if (!seen.has(r) && !excluded.has(r)) stack.push(r);
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

function stringArgEquals(arg: string, value: string): boolean {
  const m = /^'([^']*)'$/.exec(arg.trim());
  return !!m && m[1] === value;
}

/** STEP real-number literal: always carries a decimal point (`6000.`, not `6000`). */
function stepNumber(v: number): string {
  return Number.isInteger(v) ? `${v}.` : String(v);
}

// ============================================================================
// Structural lookups against the REAL base file — deliberately not hardcoded
// STEP ids (the file is a fixed third-party sample, but looking entities up
// by their own Name/type is self-documenting and immune to any future
// re-export of the sample renumbering the entities).
// ============================================================================

function findEntityIdByName(index: Map<number, ParsedLine>, type: string, name: string): number {
  for (const [id, pl] of index) {
    if (pl.type === type && stringArgEquals(pl.args[2], name)) return id;
  }
  throw new Error(`no ${type} found with Name='${name}'`);
}

function findSoleEntityId(index: Map<number, ParsedLine>, type: string): number {
  let found: number | null = null;
  for (const [id, pl] of index) {
    if (pl.type !== type) continue;
    if (found !== null) throw new Error(`expected exactly one ${type}, found at least #${found} and #${id}`);
    found = id;
  }
  if (found === null) throw new Error(`no ${type} found`);
  return found;
}

/** Find an `IfcPropertySingleValue` line by walking ElementId -> IfcRelDefinesByProperties -> IfcPropertySet -> property. */
function findPropertyLine(
  index: Map<number, ParsedLine>,
  elementId: number,
  psetName: string,
  propName: string,
): number {
  for (const [, pl] of index) {
    if (pl.type !== 'IFCRELDEFINESBYPROPERTIES') continue;
    if (!collectRefs(pl.args[4]).includes(elementId)) continue;
    const psetId = refId(pl.args[5]);
    if (psetId === null) continue;
    const psetLine = index.get(psetId);
    if (!psetLine || psetLine.type !== 'IFCPROPERTYSET' || !stringArgEquals(psetLine.args[2], psetName)) continue;
    for (const propId of collectRefs(psetLine.args[4])) {
      const propLine = index.get(propId);
      if (propLine && stringArgEquals(propLine.args[0], propName)) return propId;
    }
  }
  throw new Error(`property ${psetName}.${propName} not found for entity #${elementId}`);
}

/** ElementId -> IfcLocalPlacement -> IfcAxis2Placement3D -> IfcCartesianPoint (Location). */
function resolveElementLocationPointId(index: Map<number, ParsedLine>, elementId: number): number {
  const elLine = requireLine(index, elementId);
  const placementId = refId(elLine.args[5]);
  if (placementId === null) throw new Error(`entity #${elementId} has no ObjectPlacement`);
  const placementLine = requireLine(index, placementId);
  if (placementLine.type !== 'IFCLOCALPLACEMENT') {
    throw new Error(`entity #${elementId} ObjectPlacement is not IFCLOCALPLACEMENT (${placementLine.type})`);
  }
  const axis2Id = refId(placementLine.args[1]);
  if (axis2Id === null) throw new Error(`entity #${elementId} placement has no RelativePlacement`);
  const axis2Line = requireLine(index, axis2Id);
  const pointId = refId(axis2Line.args[0]);
  if (pointId === null) throw new Error(`entity #${elementId} axis2placement has no Location point`);
  return pointId;
}

/**
 * Pull relationships that REFERENCE (rather than are referenced BY) anything
 * already in `closure` into the closure, together with their own forward
 * closure — e.g. `IfcRelAssociatesMaterial`/`IfcStyledItem` point AT an
 * element/solid, so a plain forward walk from the element never finds them.
 * Fixed-point iterated so a newly-pulled-in entity's own closure additions
 * (e.g. a styled item's IfcSurfaceStyle chain) are followed too.
 */
function expandClosureWithIncomingRels(
  index: Map<number, ParsedLine>,
  closure: Set<number>,
  relTypes: string[],
): Set<number> {
  const wanted = new Set(relTypes);
  const result = new Set(closure);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, pl] of index) {
      if (result.has(id) || !wanted.has(pl.type)) continue;
      const refs = pl.args.flatMap(collectRefs);
      if (!refs.some((r) => result.has(r))) continue;
      for (const cid of forwardClosure(index, [id])) result.add(cid);
      changed = true;
    }
  }
  return result;
}

// ============================================================================
// The four compare deltas + one injected hard clash
// ============================================================================

/**
 * DATA-MODIFIED: flip `Pset_WallCommon.LoadBearing` on "house - outer wall -
 * house right front" (F -> T). Same GlobalId, geometry byte-identical.
 */
function applyDataModified(lines: string[], index: Map<number, ParsedLine>): string {
  const wallId = findEntityIdByName(index, 'IFCWALL', 'house - outer wall - house right front');
  const propId = findPropertyLine(index, wallId, 'Pset_WallCommon', 'LoadBearing');
  const propLine = requireLine(index, propId);
  if (propLine.args[2] !== 'IFCBOOLEAN(.F.)') {
    throw new Error(`revB data-modified: unexpected LoadBearing value '${propLine.args[2]}'`);
  }
  const newArgs = [...propLine.args];
  newArgs[2] = 'IFCBOOLEAN(.T.)';
  setLine(lines, propId, propLine.type, newArgs);
  return globalIdOf(index, wallId);
}

/**
 * GEOMETRY-MODIFIED: translate "house - outer wall - house right back" by
 * +500mm along X via its placement's IfcCartesianPoint (the base file's
 * length unit is millimetre). Same GlobalId, same shape — only the world
 * position changes.
 */
function applyGeometryModified(lines: string[], index: Map<number, ParsedLine>): string {
  const wallId = findEntityIdByName(index, 'IFCWALL', 'house - outer wall - house right back');
  const pointId = resolveElementLocationPointId(index, wallId);
  const pointLine = requireLine(index, pointId);
  const coordsText = pointLine.args[0];
  const coords = coordsText.slice(1, -1).split(',').map((s) => Number.parseFloat(s));
  if (coords.length !== 3 || coords.some((c) => Number.isNaN(c))) {
    throw new Error(`revB geometry-modified: could not parse CartesianPoint '${coordsText}'`);
  }
  coords[0] += 500;
  setLine(lines, pointId, 'IFCCARTESIANPOINT', [`(${coords.map(stepNumber).join(',')})`]);
  return globalIdOf(index, wallId);
}

/**
 * DELETED: remove the "kitchen" IfcFurniture entirely, scrubbing every
 * dangling reference. Two shapes exercised deliberately:
 *  - IfcRelDefinesByType / IfcRelAssociatesMaterial: the furniture is the
 *    SOLE related object -> the whole rel becomes meaningless -> dropped.
 *  - IfcRelContainedInSpatialStructure: the furniture shares the rel with a
 *    sibling proxy -> only the furniture's own reference is removed, the
 *    rel survives with its remaining member.
 */
function applyDelete(lines: string[], index: Map<number, ParsedLine>): { lines: string[]; deletedGlobalId: string } {
  const furnitureId = findEntityIdByName(index, 'IFCFURNITURE', 'kitchen');
  const deletedGlobalId = globalIdOf(index, furnitureId);
  const furnitureLineIdx = requireLine(index, furnitureId).lineIndex;

  let newLines = lines.filter((_, i) => i !== furnitureLineIdx);

  const ref = new RegExp(`#${furnitureId}(?![0-9])`);
  newLines = newLines.flatMap((line) => {
    if (!ref.test(line)) return [line];
    const scrubbed = line
      .replace(new RegExp(`#${furnitureId}(?![0-9]),`, 'g'), '')
      .replace(new RegExp(`,#${furnitureId}(?![0-9])`, 'g'), '')
      .replace(new RegExp(`\\(#${furnitureId}(?![0-9])\\)`, 'g'), '()');
    if (scrubbed.includes('()')) return []; // sole member - the rel is meaningless now
    if (ref.test(scrubbed)) {
      throw new Error(`revB delete: unhandled reference to deleted furniture: ${line.slice(0, 100)}`);
    }
    return [scrubbed];
  });

  return { lines: newLines, deletedGlobalId };
}

interface AddedDuctFragment {
  lines: string[];
  ductGlobalId: string;
}

/**
 * ADDED + injected HARD CLASH: splice in a fresh IfcDuctSegment (rectangular
 * profile, matching the base's own extruded-solid style) that pierces clean
 * through "house - outer wall - house left" (200mm thick) by its full
 * thickness — comfortably over the 50mm hard-clash floor. `IfcDuct*` vs
 * `IfcWall` is the HVACxARCH pair in packages/clash/src/disciplines.ts.
 *
 * A throwaway IfcCreator authors the duct with correct STEP grammar; only
 * its true dependency subtree (placement, profile, solid, shape rep,
 * material, styled item) is harvested — the scratch document's own
 * project/site/building/storey chain is discarded. The duct's own
 * IfcLocalPlacement is grafted directly onto the REAL base storey's
 * placement (its `PlacementRelTo` is rewritten from the scratch identity
 * placement to the base storey's placement id) so the duct lands in the
 * same coordinate frame as every other element directly under that storey.
 */
function buildAddedDuctFragment(opts: {
  baseMaxId: number;
  realStoreyEntityId: number;
  realStoreyPlacementId: number;
  baseOwnerHistoryId: number;
}): AddedDuctFragment {
  const { baseMaxId, realStoreyEntityId, realStoreyPlacementId, baseOwnerHistoryId } = opts;

  // NOTE: IfcCreator's `LengthUnit` option only changes ITS OWN header
  // declaration (discarded below) — it never scales the numeric literals it
  // emits (see packages/create/src/ifc-creator.ts `addLocalPlacement`/`num`).
  // The harvested subtree's raw numbers are therefore used as-is by the base
  // file's real unit (millimetre), so every dimension below is millimetre-scaled.
  const creator2 = new IfcCreator({ Name: 'demo-kit-scratch', Schema: 'IFC4', LengthUnit: 'MILLIMETRE' });
  const scratchStorey = creator2.addIfcBuildingStorey({ Name: 'scratch', Elevation: 0 });
  const ductId = creator2.addAxisElement(scratchStorey, {
    IfcType: 'IFCDUCTSEGMENT',
    // Runs along +X through the wall's 0..200mm thickness band at Y=3000
    // (mid-span of the wall's 0..6000mm length) and Z=1500mm (well inside
    // its -250..3375mm height) — full 200mm overlap along the piercing axis.
    Start: [-300, 3000, 1500],
    End: [500, 3000, 1500],
    Profile: { ProfileType: 'AREA', XDim: 200, YDim: 150 },
    Name: 'Duct D-New (unrouted MEP run)',
    PredefinedType: 'RIGIDSEGMENT',
  });
  creator2.addIfcMaterial(ductId, { Name: 'Steel', Category: 'MEP' });
  creator2.setColor(ductId, 'Steel', [0.55, 0.58, 0.62]);

  const { content: addonContent } = creator2.toIfc();
  const addonLines = addonContent.split('\n');
  const addonIndex = buildIndex(addonLines);

  // Sever the scratch document's own identity placement — its
  // `PlacementRelTo` is rewritten below to the real base storey's placement.
  // Only THAT one entity is excluded (not its whole descendant chain):
  // IfcCreator shares/caches leaf entities (e.g. the default extrusion
  // direction reuses the same IfcDirection as the world placement's Z axis),
  // so a leaf reachable via the excluded placement can ALSO be reachable via
  // a completely different edge (the solid's own ExtrudedDirection arg) and
  // must still be harvested.
  const ductLine = requireLine(addonIndex, ductId);
  const ductPlacementId = refId(ductLine.args[5])!;
  const ductPlacementLine = requireLine(addonIndex, ductPlacementId);
  const scratchWorldPlacementId = refId(ductPlacementLine.args[0])!;

  let closure = forwardClosureExcluding(addonIndex, [ductId], new Set([scratchWorldPlacementId]));
  closure = expandClosureWithIncomingRels(addonIndex, closure, ['IFCRELASSOCIATESMATERIAL', 'IFCSTYLEDITEM']);

  const shift = baseMaxId + 10;
  const remapArg = (arg: string): string =>
    arg.replace(/#(\d+)/g, (whole, digits) => {
      const n = Number(digits);
      if (n === scratchWorldPlacementId) return `#${realStoreyPlacementId}`;
      return closure.has(n) ? `#${n + shift}` : whole;
    });

  const harvestLines: string[] = [];
  for (const id of closure) {
    const pl = addonIndex.get(id)!;
    harvestLines.push(`#${id + shift}=${pl.type}(${pl.args.map(remapArg).join(',')});`);
  }

  const shiftedDuctId = ductId + shift;
  // Above every harvested id: closure ids are a sparse SUBSET of the addon
  // doc's numbering, so `shift + closure.size + 1` can collide with a
  // harvested `id + shift` (see old generate.mts — it did, duplicate #1246
  // in an earlier kit). Always derive from `Math.max(...closure)`.
  const containRelId = shift + Math.max(...closure) + 1;
  const containGuid = generateIfcGuid();
  harvestLines.push(
    `#${containRelId}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${containGuid}',#${baseOwnerHistoryId},$,$,(#${shiftedDuctId}),#${realStoreyEntityId});`,
  );

  return { lines: harvestLines, ductGlobalId: globalIdOf(addonIndex, ductId) };
}

// ============================================================================
// IDS document — validated against the BASE (unmodified) model. Every spec
// is grounded in real variance discovered by inspecting the base model's
// actual content (see report): only the "plumbing wall" has
// Pset_WallCommon.IsExternal = FALSE (the other 3 walls are TRUE), and only
// 3 of 5 IfcBuildingElementProxy entities carry an ObjectType.
// ============================================================================

function buildIdsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info>
    <title>Building Architecture IDS</title>
    <description>Sample buildingSMART IDS specifications for the ifc-lite interactive tour demo kit, grounded in the real "ifc silly sample scene" content.</description>
    <author>ifc-lite</author>
  </info>
  <specifications>
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
    <specification name="Walls are external" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCWALL</simpleValue></name>
        </entity>
      </applicability>
      <requirements>
        <property dataType="IFCBOOLEAN">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>IsExternal</simpleValue></baseName>
          <value><simpleValue>true</simpleValue></value>
        </property>
      </requirements>
    </specification>
    <specification name="Building element proxies declare an ObjectType" ifcVersion="IFC4">
      <applicability>
        <entity>
          <name><simpleValue>IFCBUILDINGELEMENTPROXY</simpleValue></name>
        </entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>ObjectType</simpleValue></name>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>
`;
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
  console.log('Reading committed base sample...');
  const baseContent = await readFile(BASE_FILE, 'utf-8');
  let lines = baseContent.split('\n');
  let index = buildIndex(lines);

  console.log('Applying DATA-MODIFIED delta...');
  const dataModifiedGlobalId = applyDataModified(lines, index);
  index = buildIndex(lines);

  console.log('Applying GEOMETRY-MODIFIED delta...');
  const geometryMovedGlobalId = applyGeometryModified(lines, index);
  index = buildIndex(lines);

  console.log('Applying DELETED delta...');
  const deleteResult = applyDelete(lines, index);
  lines = deleteResult.lines;
  const deletedGlobalId = deleteResult.deletedGlobalId;
  index = buildIndex(lines);

  console.log('Splicing in ADDED element + injected hard clash...');
  const storeyId = findSoleEntityId(index, 'IFCBUILDINGSTOREY');
  const storeyPlacementId = refId(requireLine(index, storeyId).args[5])!;
  const ownerHistoryId = findSoleEntityId(index, 'IFCOWNERHISTORY');
  const clashHitWallId = findEntityIdByName(index, 'IFCWALL', 'house - outer wall - house left');
  const clashHitGlobalId = globalIdOf(index, clashHitWallId);

  let baseMaxId = 0;
  for (const id of index.keys()) if (id > baseMaxId) baseMaxId = id;

  const { lines: addedLines, ductGlobalId } = buildAddedDuctFragment({
    baseMaxId,
    realStoreyEntityId: storeyId,
    realStoreyPlacementId: storeyPlacementId,
    baseOwnerHistoryId: ownerHistoryId,
  });

  const endsecIdx = lines.lastIndexOf('ENDSEC;');
  if (endsecIdx === -1) throw new Error('revB: closing ENDSEC; not found');
  lines.splice(endsecIdx, 0, ...addedLines);

  const revBContent = lines.join('\n');

  // IDS specs (grounded in the base model's real variance) + manifest also
  // need a couple of base-only lookups.
  const baseIndexFresh = buildIndex(baseContent.split('\n'));
  const plumbingWallGlobalId = globalIdOf(baseIndexFresh, findEntityIdByName(baseIndexFresh, 'IFCWALL', 'plumbing wall'));
  const proxyGroup18GlobalId = globalIdOf(baseIndexFresh, findEntityIdByName(baseIndexFresh, 'IFCBUILDINGELEMENTPROXY', 'Group#18'));
  const proxyGroup19GlobalId = globalIdOf(baseIndexFresh, findEntityIdByName(baseIndexFresh, 'IFCBUILDINGELEMENTPROXY', 'Group#19'));
  const storeyName = requireLine(baseIndexFresh, findSoleEntityId(baseIndexFresh, 'IFCBUILDINGSTOREY')).args[2].slice(1, -1);

  const idsXml = buildIdsXml();

  const pins = {
    dataModified: dataModifiedGlobalId,
    geometryMoved: geometryMovedGlobalId,
    deleted: deletedGlobalId,
    added: ductGlobalId,
    clashAdded: ductGlobalId,
    clashHit: clashHitGlobalId,
  };

  const manifest = {
    version: 1,
    base: 'samples/building-architecture.ifc',
    revB: 'samples/building-architecture-rev-b.ifc',
    ids: 'samples/building-architecture.ids',
    clash: 'samples/building-architecture-rev-b.ifc',
    globalIds: pins,
    facts: {
      storeys: [storeyName],
      searchTerm: 'wall',
      clashPair: 'IfcDuctSegment vs IfcWall',
    },
  };

  console.log('Writing derived artifacts to apps/viewer/public/samples/...');
  await writeFile(REV_B_FILE, revBContent, 'utf-8');
  await writeFile(IDS_FILE, idsXml, 'utf-8');
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8');

  // ==========================================================================
  // Self-verification
  // ==========================================================================
  console.log('Running self-verification...\n');

  const baseBytesOnDisk = new Uint8Array(await readFile(BASE_FILE));
  const revBBytesOnDisk = new Uint8Array(await readFile(REV_B_FILE));

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

  // --- 2. IDS (validated against the BASE model) ---
  let idsSpecSummaries: string[] = [];
  try {
    const idsText = await readFile(IDS_FILE, 'utf-8');
    const audit = await auditIDSDocument(idsText);
    check('ids.audit', audit.status !== 'error', `audit status=${audit.status}, issues=${audit.issues.length}`);

    const doc = parseIDS(idsText);
    const accessor = createDataAccessor(baseStore);
    const report = await validateIDS(doc, accessor, { schemaVersion: baseStore.schemaVersion }, { includePassingEntities: true });

    const [spec1, spec2, spec3] = report.specificationResults;
    idsSpecSummaries = report.specificationResults.map(
      (s: any) => `${s.specification.name}: ${s.passedCount}/${s.applicableCount} passed, ${s.failedCount} failed`,
    );

    check('ids.spec1.allPass', spec1.failedCount === 0 && spec1.applicableCount === 2,
      `Spaces are named: ${spec1.passedCount}/${spec1.applicableCount} passed (expected 2/2)`);

    const spec2FailedIds = spec2.entityResults.filter((r: any) => !r.passed).map((r: any) => r.globalId).sort();
    check('ids.spec2.mixed', spec2.applicableCount === 4 && spec2.failedCount === 1 &&
      JSON.stringify(spec2FailedIds) === JSON.stringify([plumbingWallGlobalId]),
      `Walls are external: ${spec2.passedCount}/${spec2.applicableCount} passed, failing=${JSON.stringify(spec2FailedIds)} (expected exactly the plumbing wall)`);

    const spec3FailedIds = spec3.entityResults.filter((r: any) => !r.passed).map((r: any) => r.globalId).sort();
    const expectedSpec3Failed = [proxyGroup18GlobalId, proxyGroup19GlobalId].sort();
    check('ids.spec3.mixed', spec3.applicableCount === 5 && spec3.failedCount === 2 &&
      JSON.stringify(spec3FailedIds) === JSON.stringify(expectedSpec3Failed),
      `Proxies declare ObjectType: ${spec3.passedCount}/${spec3.applicableCount} passed, failing=${JSON.stringify(spec3FailedIds)} (expected Group#18 + Group#19)`);
  } catch (err) {
    check('ids.validation', false, `threw: ${(err as Error).message}`);
  }

  // --- Mesh both models once (shared by clash + diff checks) ---
  const processor = new GeometryProcessor();
  await processor.init();
  processor.enableGeometryHashes();
  const { meshes: baseMeshes } = await processor.process(baseBytesOnDisk);
  const { meshes: revBMeshes } = await processor.process(revBBytesOnDisk);

  // --- 3. Clash (on revision B) ---
  try {
    const { elements, exclusions } = elementsFromStep({ store: revBStore, meshes: revBMeshes, modelId: 'revB' });
    const engine = createClashEngine({ backend: 'ts' });
    const clashResult = await engine.run(elements, disciplineMatrixRules('hard'), { exclusions });

    const pinnedPair = clashResult.clashes.find((c: Clash) =>
      c.status === 'hard' &&
      ((c.a.key === pins.clashAdded && c.b.key === pins.clashHit) ||
        (c.a.key === pins.clashHit && c.b.key === pins.clashAdded)));

    const penetrationM = pinnedPair ? Math.abs(pinnedPair.distance) : 0;
    check('clash.pinnedPairPresent', !!pinnedPair && penetrationM >= 0.05,
      pinnedPair
        ? `found duct-vs-wall hard clash, penetration=${(penetrationM * 1000).toFixed(1)}mm`
        : 'pinned duct/wall pair NOT found as a hard clash');
    check('clash.countBounded', clashResult.summary.total <= 30,
      `total clashes=${clashResult.summary.total} (<=30 required)`);
  } catch (err) {
    check('clash.run', false, `threw: ${(err as Error).message}`);
  }

  // --- 4. Diff (base vs revision B) ---
  try {
    const baseFps = buildFingerprints(baseStore, baseMeshes);
    const revBFps = buildFingerprints(revBStore, revBMeshes);
    const modelDiff = diffModels(baseFps, revBFps, { scope: 'both' });

    check('diff.counts', modelDiff.counts.added === 1 && modelDiff.counts.deleted === 1 && modelDiff.counts.modified === 2,
      `added=${modelDiff.counts.added} deleted=${modelDiff.counts.deleted} modified=${modelDiff.counts.modified} unchanged=${modelDiff.counts.unchanged}`);

    const addedEntry = modelDiff.byKey.get(pins.added);
    check('diff.added.matchesPin', addedEntry?.state === 'added', `added entry state=${addedEntry?.state}`);

    const deletedEntry = modelDiff.byKey.get(pins.deleted);
    check('diff.deleted.matchesPin', deletedEntry?.state === 'deleted', `deleted entry state=${deletedEntry?.state}`);

    const dataEntry = modelDiff.byKey.get(pins.dataModified);
    check('diff.dataModified.matchesPin',
      dataEntry?.state === 'modified' && JSON.stringify(dataEntry.changeKinds) === JSON.stringify(['data']),
      `dataModified entry state=${dataEntry?.state} changeKinds=${JSON.stringify(dataEntry?.changeKinds)}`);

    const geomEntry = modelDiff.byKey.get(pins.geometryMoved);
    check('diff.geometryModified.matchesPin',
      geomEntry?.state === 'modified' && JSON.stringify(geomEntry.changeKinds) === JSON.stringify(['geometry']),
      `geometryMoved entry state=${geomEntry?.state} changeKinds=${JSON.stringify(geomEntry?.changeKinds)}`);
  } catch (err) {
    check('diff.run', false, `threw: ${(err as Error).message}`);
  }

  // --- 5. Added artifact size ---
  const sizes = {
    'building-architecture-rev-b.ifc': Buffer.byteLength(revBContent, 'utf-8'),
    'building-architecture.ids': Buffer.byteLength(idsXml, 'utf-8'),
    'demo-kit.json': Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf-8'),
  };
  const totalAddedBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
  check('size.addedBudget', totalAddedBytes <= 400 * 1024, `added=${(totalAddedBytes / 1024).toFixed(1)}KB (<=400KB required)`);

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log('\nDerived artifact sizes:');
  for (const [name, bytes] of Object.entries(sizes)) {
    console.log(`  ${name.padEnd(34)} ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
  console.log(`  ${'TOTAL (derived only)'.padEnd(34)} ${(totalAddedBytes / 1024).toFixed(1).padStart(8)} KB`);

  console.log('\nPinned GlobalIds:');
  for (const [k, v] of Object.entries(pins)) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }

  console.log('\nIDS specification results (vs BASE):');
  for (const line of idsSpecSummaries) {
    console.log(`  ${line}`);
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
  console.error('demo-kit derive-variants failed:', err);
  process.exitCode = 1;
});
