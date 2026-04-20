/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.create namespace methods.
 *
 * Auto-discovers public methods on IfcCreator.prototype and builds
 * the corresponding bridge method schemas. Adding a new public method
 * to IfcCreator automatically exposes it in the sandbox.
 */

import { IfcCreator } from '@ifc-lite/sdk';
import type { MethodSchema, MethodSemanticContract } from './bridge-schema.js';
import { creatorRegistry } from './creator-registry.js';
import { buildScheduleMethods, SCHEDULE_SPECIAL_METHOD_NAMES } from './bridge-create-schedule.js';

// ============================================================================
// Auto-discovery for bim.create (IfcCreator methods)
// ============================================================================

/**
 * Classify IfcCreator methods by their signature pattern so we can
 * auto-generate the correct bridge wiring.
 *
 * Patterns (all prepend a `handle` arg for the creator registry):
 *   'storey-params'  — (storeyId: number, params: object) → number
 *   'element-params' — (elementId: number, params: object) → number | void
 *   'single-dump'    — (params: object) → number
 *   'no-args'        — () → value  (e.g. getWorldPlacementId)
 *   'special'        — handled individually (project, toIfc, setColor)
 */
type MethodPattern = 'storey-params' | 'element-params' | 'single-dump' | 'no-args' | 'special';

/** Methods with non-standard signatures that need hand-written wiring */
const SPECIAL_METHODS = new Set<string>([
  'constructor', 'toIfc', 'setColor',
  // Scheduling lives in bridge-create-schedule.ts — exported list keeps the
  // two files synchronised without duplicating the method names.
  ...SCHEDULE_SPECIAL_METHOD_NAMES,
]);

/**
 * Explicit allow-list of IfcCreator methods exposed in the sandbox.
 * Only methods in this set (or in SPECIAL_METHODS/ELEMENT_METHODS/ZERO_ARG_METHODS)
 * are wired. This prevents accidental exposure of private/internal helpers.
 */
const ALLOWED_METHODS = new Set([
  // Spatial structure
  'addIfcBuildingStorey',
  // Building elements
  'addIfcWall', 'addIfcSlab', 'addIfcColumn', 'addIfcBeam',
  'addIfcStair', 'addIfcRoof', 'addIfcGableRoof', 'addIfcWallDoor', 'addIfcWallWindow', 'addIfcDoor', 'addIfcWindow',
  'addIfcRamp', 'addIfcRailing', 'addIfcPlate', 'addIfcMember',
  'addIfcFooting', 'addIfcPile', 'addIfcSpace', 'addIfcCurtainWall',
  'addIfcFurnishingElement', 'addIfcBuildingElementProxy',
  // Specialized profiles
  'addIfcCircularColumn', 'addIfcIShapeBeam',
  'addIfcLShapeMember', 'addIfcTShapeMember', 'addIfcUShapeMember',
  'addIfcHollowCircularColumn', 'addIfcRectangleHollowBeam',
  // Generic element creation
  'addElement', 'addAxisElement', 'createProfile',
  // Properties and materials
  'addIfcPropertySet', 'addIfcElementQuantity', 'addIfcMaterial',
  // Scheduling / 4D (IfcTask, IfcWorkSchedule, IfcRelSequence)
  'addIfcWorkSchedule', 'addIfcWorkPlan', 'addIfcTask', 'addIfcRelSequence',
  // Canonical IFC relationship names — preferred for schema compliance.
  'addIfcRelAssignsToControl', 'addIfcRelAssignsToProcess', 'addIfcRelNests',
  // Ergonomic aliases retained for script authors.
  'assignTasksToWorkSchedule', 'assignSchedulesToWorkPlan',
  'assignProductsToTask', 'nestTasks',
  // Low-level geometry
  'getWorldPlacementId',
]);

/** Methods that take (elementId, def) instead of (storeyId, params) */
const ELEMENT_METHODS = new Set([
  'addIfcWallDoor', 'addIfcWallWindow',
  'addIfcPropertySet', 'addIfcElementQuantity', 'addIfcMaterial',
]);

/** Methods that take a single params object after the handle */
const SINGLE_DUMP_METHODS = new Set([
  'createProfile',
]);

/** Methods with zero args (just need the handle) */
const ZERO_ARG_METHODS = new Set([
  'getWorldPlacementId',
]);

function classifyMethod(name: string, _fn: Function): MethodPattern {
  if (SPECIAL_METHODS.has(name)) return 'special';
  if (ZERO_ARG_METHODS.has(name)) return 'no-args';
  if (SINGLE_DUMP_METHODS.has(name)) return 'single-dump';
  if (ELEMENT_METHODS.has(name)) return 'element-params';
  return 'storey-params';
}

/** Humanize a method name for the doc string */
function methodDoc(name: string): string {
  // addIfcWall → 'Add an IfcWall'
  // addElement → 'Add a generic element'
  // createProfile → 'Create a profile from a ProfileDef'
  if (name === 'addIfcMaterial') return 'Associate a material with an element via IfcRelAssociatesMaterial (deferred to toIfc). Returns nothing.';
  if (name === 'addIfcBuildingStorey') return 'Add a building storey. Returns storey expressId.';
  if (name === 'addIfcGableRoof') return 'Add a dual-pitch gable roof. `Slope` is in radians. Returns roof expressId.';
  if (name === 'addIfcWallDoor') return 'Add a door hosted in a wall opening. Position is wall-local [alongWall, 0, baseHeight]. Returns door expressId.';
  if (name === 'addIfcWallWindow') return 'Add a window hosted in a wall opening. Position is wall-local [alongWall, 0, sillHeight]. Returns window expressId.';
  if (name === 'addElement') return 'Create ANY IFC type with a profile at a placement. Returns expressId.';
  if (name === 'addAxisElement') return 'Create ANY IFC type extruded along a Start→End axis. Returns expressId.';
  if (name === 'createProfile') return 'Create a profile from a ProfileDef union. Returns profile ID.';
  if (name === 'getWorldPlacementId') return 'Get the world placement ID for use with addLocalPlacement.';
  if (name.startsWith('addIfc')) {
    const entity = name.slice(3); // remove 'add', keep 'IfcWall' etc.
    return `Add ${entity}. Returns expressId.`;
  }
  if (name.startsWith('add')) {
    const what = name.slice(3);
    return `Add ${what}. Returns ID.`;
  }
  return `Call ${name} on the creator.`;
}

const CREATE_METHOD_SEMANTICS: Partial<Record<string, MethodSemanticContract>> = {
  project: {
    taskTags: ['create', 'repair'],
    useWhen: 'Start a new generated IFC model before creating storeys and elements.',
  },
  toIfc: {
    taskTags: ['create', 'export'],
    useWhen: 'Finalize the in-memory IFC model and produce STEP content for preview or download.',
  },
  setColor: {
    taskTags: ['visualize', 'repair'],
    useWhen: 'Assign a named RGB color to a created element using [r, g, b] values between 0 and 1.',
  },
  addIfcBuildingStorey: {
    taskTags: ['create', 'repair'],
    requiredKeys: ['Elevation'],
    useWhen: 'Create a building storey container before adding level-based geometry.',
  },
  addIfcWall: {
    taskTags: ['create', 'repair'],
    placement: 'storey-relative',
    requiredKeys: ['Start', 'End', 'Thickness', 'Height'],
    positiveKeys: ['Thickness', 'Height'],
    pointArity: { Start: 3, End: 3 },
    axisPair: ['Start', 'End'],
    useWhen: 'Create a wall from a start/end axis on the current storey.',
  },
  addIfcSlab: {
    taskTags: ['create', 'repair'],
    placement: 'storey-relative',
    requiredKeys: ['Position', 'Thickness'],
    anyOfKeys: [['Profile'], ['Width', 'Depth']],
    positiveKeys: ['Thickness', 'Width', 'Depth'],
    pointArity: { Position: 3 },
    customValidationId: 'slab-shape',
    useWhen: 'Create a slab from a rectangular footprint or a 2D point-array profile.',
  },
  addIfcColumn: {
    taskTags: ['create', 'repair'],
    placement: 'storey-relative',
    requiredKeys: ['Position', 'Width', 'Depth', 'Height'],
    positiveKeys: ['Width', 'Depth', 'Height'],
    pointArity: { Position: 3 },
    useWhen: 'Create a vertical column from a base position and dimensions.',
  },
  addIfcBeam: {
    taskTags: ['create', 'repair'],
    placement: 'storey-relative',
    requiredKeys: ['Start', 'End', 'Width', 'Height'],
    positiveKeys: ['Width', 'Height'],
    pointArity: { Start: 3, End: 3 },
    axisPair: ['Start', 'End'],
    useWhen: 'Create a beam from an axis on the current storey.',
  },
  addIfcMember: {
    taskTags: ['create', 'repair'],
    placement: 'world',
    requiredKeys: ['Start', 'End', 'Width', 'Height'],
    positiveKeys: ['Width', 'Height'],
    pointArity: { Start: 3, End: 3 },
    axisPair: ['Start', 'End'],
    useWhen: 'Create mullions, braces, or facade members with explicit world coordinates.',
    cautions: [
      'Inside storey loops, include the current storey elevation in Start/End Z for facade members.',
    ],
  },
  addIfcPlate: {
    taskTags: ['create', 'repair'],
    placement: 'world',
    requiredKeys: ['Position', 'Width', 'Depth', 'Thickness'],
    positiveKeys: ['Width', 'Depth', 'Thickness'],
    pointArity: { Position: 3 },
    forbiddenKeys: [
      { key: 'Height', message: '`bim.create.addIfcPlate(...)` uses `Depth` and `Thickness`, not `Height`.' },
      { key: 'Start', message: '`bim.create.addIfcPlate(...)` uses `Position`, not `Start`/`End`.' },
      { key: 'End', message: '`bim.create.addIfcPlate(...)` uses `Position`, not `Start`/`End`.' },
    ],
    useWhen: 'Create thin world-placement panels or facade plates from a base point.',
    cautions: [
      'Facade plates repeated by storey usually need absolute Z = elevation + localOffset.',
    ],
  },
  addIfcCurtainWall: {
    taskTags: ['create', 'repair'],
    placement: 'world',
    requiredKeys: ['Start', 'End', 'Height'],
    positiveKeys: ['Height', 'Thickness'],
    pointArity: { Start: 3, End: 3 },
    axisPair: ['Start', 'End'],
    useWhen: 'Create a world-placement curtain wall segment between two points.',
    cautions: [
      'Inside storey loops, include the current storey elevation in Start/End Z.',
    ],
  },
  addIfcRailing: {
    taskTags: ['create', 'repair'],
    placement: 'world',
    requiredKeys: ['Start', 'End', 'Height'],
    positiveKeys: ['Height', 'Width'],
    pointArity: { Start: 3, End: 3 },
    axisPair: ['Start', 'End'],
    useWhen: 'Create a world-placement railing along an axis.',
  },
  addIfcStair: {
    taskTags: ['create', 'repair'],
    placement: 'storey-relative',
    requiredKeys: ['Position', 'NumberOfRisers', 'RiserHeight', 'TreadLength', 'Width'],
    positiveKeys: ['NumberOfRisers', 'RiserHeight', 'TreadLength', 'Width'],
    pointArity: { Position: 3 },
    useWhen: 'Create a stair from a base position and riser/tread definition.',
  },
  addIfcRoof: {
    taskTags: ['create', 'repair'],
    placement: 'storey-relative',
    requiredKeys: ['Position', 'Width', 'Depth', 'Thickness'],
    positiveKeys: ['Width', 'Depth', 'Thickness', 'Slope'],
    pointArity: { Position: 3 },
    forbiddenKeys: [
      { key: 'Profile', message: '`bim.create.addIfcRoof(...)` does not support `Profile`. Use `Position`, `Width`, `Depth`, `Thickness`, and optional `Slope`.' },
      { key: 'ExtrusionHeight', message: '`bim.create.addIfcRoof(...)` uses `Depth`, not `ExtrusionHeight`.' },
      { key: 'Height', message: '`bim.create.addIfcRoof(...)` uses `Thickness` and `Depth`, not `Height`.' },
      { key: 'Overhang', message: '`bim.create.addIfcRoof(...)` does not support `Overhang`. Use `addIfcGableRoof(...)` for a house-style roof with pitch and overhang.' },
    ],
    customValidationId: 'roof-shape',
    useWhen: 'Create flat or mono-pitch roof slabs only.',
    cautions: [
      'Slope is in radians.',
      'Use addIfcGableRoof for house, pitched-roof, or gable-roof requests.',
    ],
  },
  addIfcGableRoof: {
    taskTags: ['create', 'repair'],
    placement: 'storey-relative',
    requiredKeys: ['Position', 'Width', 'Depth', 'Thickness', 'Slope'],
    positiveKeys: ['Width', 'Depth', 'Thickness', 'Slope'],
    pointArity: { Position: 3 },
    forbiddenKeys: [
      { key: 'Profile', message: '`bim.create.addIfcGableRoof(...)` does not support `Profile`. Use `Position`, `Width`, `Depth`, `Thickness`, `Slope`, and optional `Overhang`.' },
      { key: 'ExtrusionHeight', message: '`bim.create.addIfcGableRoof(...)` uses `Thickness`, not `ExtrusionHeight`.' },
      { key: 'Height', message: '`bim.create.addIfcGableRoof(...)` uses `Thickness` for roof thickness and derives ridge height from `Slope`.' },
    ],
    customValidationId: 'roof-shape',
    useWhen: 'Create standard dual-pitch house roofs.',
    cautions: [
      'Slope is in radians.',
    ],
  },
  addIfcWallDoor: {
    taskTags: ['create', 'repair'],
    placement: 'wall-local',
    requiredKeys: ['Position', 'Width', 'Height'],
    positiveKeys: ['Width', 'Height', 'Thickness'],
    pointArity: { Position: 3 },
    forbiddenKeys: [
      { key: 'Start', message: '`bim.create.addIfcWallDoor(...)` uses wall-local `Position`, not `Start`/`End`.' },
      { key: 'End', message: '`bim.create.addIfcWallDoor(...)` uses wall-local `Position`, not `Start`/`End`.' },
      { key: 'Rotation', message: '`bim.create.addIfcWallDoor(...)` auto-aligns to the host wall. Do not pass `Rotation`.' },
      { key: 'Direction', message: '`bim.create.addIfcWallDoor(...)` auto-aligns to the host wall. Do not pass `Direction`.' },
      { key: 'Axis', message: '`bim.create.addIfcWallDoor(...)` auto-aligns to the host wall. Do not pass `Axis`.' },
      { key: 'RefDirection', message: '`bim.create.addIfcWallDoor(...)` auto-aligns to the host wall. Do not pass `RefDirection`.' },
      { key: 'Placement', message: '`bim.create.addIfcWallDoor(...)` uses wall-local `Position`, not `Placement`.' },
    ],
    useWhen: 'Create a wall-hosted door aligned to a host wall.',
  },
  addIfcWallWindow: {
    taskTags: ['create', 'repair'],
    placement: 'wall-local',
    requiredKeys: ['Position', 'Width', 'Height'],
    positiveKeys: ['Width', 'Height', 'Thickness'],
    pointArity: { Position: 3 },
    forbiddenKeys: [
      { key: 'Start', message: '`bim.create.addIfcWallWindow(...)` uses wall-local `Position`, not `Start`/`End`.' },
      { key: 'End', message: '`bim.create.addIfcWallWindow(...)` uses wall-local `Position`, not `Start`/`End`.' },
      { key: 'Rotation', message: '`bim.create.addIfcWallWindow(...)` auto-aligns to the host wall. Do not pass `Rotation`.' },
      { key: 'Direction', message: '`bim.create.addIfcWallWindow(...)` auto-aligns to the host wall. Do not pass `Direction`.' },
      { key: 'Axis', message: '`bim.create.addIfcWallWindow(...)` auto-aligns to the host wall. Do not pass `Axis`.' },
      { key: 'RefDirection', message: '`bim.create.addIfcWallWindow(...)` auto-aligns to the host wall. Do not pass `RefDirection`.' },
      { key: 'Placement', message: '`bim.create.addIfcWallWindow(...)` uses wall-local `Position`, not `Placement`.' },
    ],
    useWhen: 'Create a wall-hosted window aligned to a host wall.',
  },
  addIfcDoor: {
    taskTags: ['create', 'repair'],
    placement: 'world',
    requiredKeys: ['Position', 'Width', 'Height'],
    positiveKeys: ['Width', 'Height', 'Thickness'],
    pointArity: { Position: 3 },
    forbiddenKeys: [
      { key: 'Start', message: '`bim.create.addIfcDoor(...)` uses `Position`, not `Start`/`End`.' },
      { key: 'End', message: '`bim.create.addIfcDoor(...)` uses `Position`, not `Start`/`End`.' },
      { key: 'Direction', message: '`bim.create.addIfcDoor(...)` does not support wall-axis rotation. It creates a world-aligned standalone door element.' },
      { key: 'Rotation', message: '`bim.create.addIfcDoor(...)` does not support rotation. For wall-hosted inserts, use `bim.create.addIfcWallDoor(...)` or wall `Openings`.' },
      { key: 'Axis', message: '`bim.create.addIfcDoor(...)` does not accept `Axis`. It is not a generic placement API.' },
      { key: 'RefDirection', message: '`bim.create.addIfcDoor(...)` does not accept `RefDirection`. It is not auto-aligned to wall direction.' },
      { key: 'Placement', message: '`bim.create.addIfcDoor(...)` uses `Position`, not `Placement`.' },
    ],
    useWhen: 'Create a standalone world-aligned door element.',
    cautions: [
      'For wall-hosted inserts, use addIfcWallDoor or wall Openings instead.',
    ],
  },
  addIfcWindow: {
    taskTags: ['create', 'repair'],
    placement: 'world',
    requiredKeys: ['Position', 'Width', 'Height'],
    positiveKeys: ['Width', 'Height', 'Thickness'],
    pointArity: { Position: 3 },
    forbiddenKeys: [
      { key: 'Start', message: '`bim.create.addIfcWindow(...)` uses `Position`, not `Start`/`End`.' },
      { key: 'End', message: '`bim.create.addIfcWindow(...)` uses `Position`, not `Start`/`End`.' },
      { key: 'Direction', message: '`bim.create.addIfcWindow(...)` does not support wall-axis rotation. It creates a world-aligned standalone window element.' },
      { key: 'Rotation', message: '`bim.create.addIfcWindow(...)` does not support rotation. For wall-hosted inserts, use `bim.create.addIfcWallWindow(...)` or wall `Openings`.' },
      { key: 'Axis', message: '`bim.create.addIfcWindow(...)` does not accept `Axis`. It is not a generic placement API.' },
      { key: 'RefDirection', message: '`bim.create.addIfcWindow(...)` does not accept `RefDirection`. It is not auto-aligned to wall direction.' },
      { key: 'Placement', message: '`bim.create.addIfcWindow(...)` uses `Position`, not `Placement`.' },
    ],
    useWhen: 'Create a standalone world-aligned window element.',
    cautions: [
      'For wall-hosted inserts, use addIfcWallWindow or wall Openings instead.',
    ],
  },
  addElement: {
    taskTags: ['create', 'repair'],
    placement: 'explicit-placement',
    requiredKeys: ['IfcType', 'Placement', 'Profile', 'Depth'],
    positiveKeys: ['Depth'],
    customValidationId: 'generic-element',
    useWhen: 'Create advanced IFC entities only when no dedicated helper exists.',
  },
  addAxisElement: {
    taskTags: ['create', 'repair'],
    placement: 'world',
    requiredKeys: ['IfcType', 'Start', 'End', 'Profile'],
    pointArity: { Start: 3, End: 3 },
    axisPair: ['Start', 'End'],
    customValidationId: 'axis-element',
    useWhen: 'Create advanced axis-based IFC entities when no dedicated helper exists.',
  },
};

/**
 * Build all bim.create method schemas by discovering public methods
 * on IfcCreator.prototype. New methods are automatically exposed.
 */
export function buildCreateMethods(): MethodSchema[] {
  const methods: MethodSchema[] = [];

  // ── Special: project (creates IfcCreator, returns handle) ──
  methods.push({
    name: 'project',
    doc: 'Create a new IFC project. Returns a creator handle (number).',
    args: ['dump'],
    paramNames: ['params'],
    tsParamTypes: ['{ Name?: string; Description?: string; Schema?: string; LengthUnit?: string; Author?: string; Organization?: string }'],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const params = (args[0] ?? {}) as ConstructorParameters<typeof IfcCreator>[0];
      const creator = new IfcCreator(params);
      return creatorRegistry.registerForSession(context.sandboxSessionId, creator);
    },
    returns: 'value',
    llmSemantics: CREATE_METHOD_SEMANTICS.project,
  });

  // ── Special: toIfc (finalizes + cleans up handle) ──
  methods.push({
    name: 'toIfc',
    doc: 'Generate the IFC STEP file content. Returns { content, entities, stats }.',
    args: ['number'],
    paramNames: ['handle'],
    tsReturn: '{ content: string; entities: Array<{ expressId: number; type: string; Name?: string }>; stats: { entityCount: number; fileSize: number } }',
    call: (_sdk, args, context) => {
      const handle = args[0] as number;
      try {
        const creator = creatorRegistry.getForSession(context.sandboxSessionId, handle);
        return creator.toIfc();
      } finally {
        creatorRegistry.removeForSession(context.sandboxSessionId, handle);
      }
    },
    returns: 'value',
    llmSemantics: CREATE_METHOD_SEMANTICS.toIfc,
  });

  // ── Special: setColor (unique signature: handle, elementId, name, rgb) ──
  methods.push({
    name: 'setColor',
    doc: 'Assign a named colour to an element. Call before toIfc().',
    args: ['number', 'number', 'string', 'dump'],
    paramNames: ['handle', 'elementId', 'name', 'rgb'],
    tsReturn: 'void',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
      creator.setColor(args[1] as number, args[2] as string, args[3] as [number, number, number]);
    },
    returns: 'void',
    llmSemantics: CREATE_METHOD_SEMANTICS.setColor,
  });

  // ── Scheduling / 4D ────────────────────────────────────────
  // IfcTask / IfcWorkSchedule / IfcRelSequence chains live in a dedicated
  // module so this file stays under the ~400-line guideline. Adding a new
  // scheduling method = touch `bridge-create-schedule.ts` only.
  methods.push(...buildScheduleMethods());

  // ── Auto-discover all other public methods from IfcCreator.prototype ──
  // Type-safe dynamic dispatch: methods are validated against ALLOWED_METHODS
  // so we use an indexed type rather than `as any`.
  type CreatorMethod = (...args: unknown[]) => unknown;
  type IndexedCreator = Record<string, CreatorMethod>;

  const proto = IfcCreator.prototype as unknown as Record<string, unknown>;
  const methodNames = Object.getOwnPropertyNames(proto)
    .filter(name => typeof proto[name] === 'function' && ALLOWED_METHODS.has(name))
    .sort();

  for (const name of methodNames) {
    const pattern = classifyMethod(name, proto[name] as Function);
    if (pattern === 'special') continue; // already handled above

    switch (pattern) {
      case 'storey-params':
        // addIfcBuildingStorey takes (params) — 1 arg after handle
        if (name === 'addIfcBuildingStorey') {
          methods.push({
            name,
            doc: methodDoc(name),
            args: ['number', 'dump'],
            paramNames: ['handle', 'params'],
            tsReturn: 'number',
            call: (_sdk, args, context) => {
              const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
              return (creator as unknown as IndexedCreator)[name](args[1]);
            },
            returns: 'value',
            llmSemantics: CREATE_METHOD_SEMANTICS[name],
          });
        } else {
          // Standard: (storeyId, params) — 2 args after handle
          methods.push({
            name,
            doc: methodDoc(name),
            args: ['number', 'number', 'dump'],
            paramNames: ['handle', 'storeyId', 'params'],
            tsReturn: 'number',
            call: (_sdk, args, context) => {
              const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
              return (creator as unknown as IndexedCreator)[name](args[1], args[2]);
            },
            returns: 'value',
            llmSemantics: CREATE_METHOD_SEMANTICS[name],
          });
        }
        break;

      case 'element-params':
        // (elementId, def) — 2 args after handle, may return number or void
        methods.push({
          name,
          doc: methodDoc(name),
          args: ['number', 'number', 'dump'],
          paramNames: ['handle', name === 'addIfcWallDoor' || name === 'addIfcWallWindow' ? 'wallId' : 'elementId', 'params'],
          tsReturn: name === 'addIfcMaterial' ? 'void' : 'number',
          call: (_sdk, args, context) => {
            const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
            return (creator as unknown as IndexedCreator)[name](args[1], args[2]);
          },
          returns: name === 'addIfcMaterial' ? 'void' : 'value',
          llmSemantics: CREATE_METHOD_SEMANTICS[name],
        });
        break;

      case 'single-dump':
        methods.push({
          name,
          doc: methodDoc(name),
          args: ['number', 'dump'],
          paramNames: ['handle', 'profile'],
          tsReturn: 'number',
          call: (_sdk, args, context) => {
            const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
            return (creator as unknown as IndexedCreator)[name](args[1]);
          },
          returns: 'value',
          llmSemantics: CREATE_METHOD_SEMANTICS[name],
        });
        break;

      case 'no-args':
        methods.push({
          name,
          doc: methodDoc(name),
          args: ['number'],
          paramNames: ['handle'],
          tsReturn: 'number',
          call: (_sdk, args, context) => {
            const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number);
            return (creator as unknown as IndexedCreator)[name]();
          },
          returns: 'value',
          llmSemantics: CREATE_METHOD_SEMANTICS[name],
        });
        break;
    }
  }

  return methods;
}
