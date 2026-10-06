/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reviewed scene actions (viewer AI P14): a serialisable, bounded description
 * of what to show in the 3D view: select, isolate, hide, colour groups, frame,
 * section and camera. Producers (assistant answers) only create this
 * description; nothing here touches the scene. `scene-preview.ts` resolves it
 * against the live store and `scene-apply.ts` applies it on an explicit click,
 * after capturing the prior view for one-click restoration.
 *
 * Coordinates are IFC world coordinates (Z-up, the axes the IFC file and BCF
 * use) in an explicitly stated length unit. They are never trusted: the
 * preview converts them to the render frame and refuses non-finite values and
 * positions outside the loaded geometry.
 */

/** An element named by IFC GlobalId, optionally restricted to one loaded model. */
export interface GlobalIdTarget { globalId: string; modelId?: string }
/** A captured evidence row (`E3`) whose element identities are resolved live. */
export interface CitationTarget { citation: string }
export type SceneTarget = GlobalIdTarget | CitationTarget;

/** Bounded colour palette: names, never arbitrary RGB, so contrast stays reviewable. */
export const SCENE_PALETTE = {
  red: [0.86, 0.15, 0.15, 1],
  orange: [0.96, 0.52, 0.05, 1],
  yellow: [0.93, 0.8, 0.1, 1],
  green: [0.16, 0.65, 0.27, 1],
  teal: [0.05, 0.6, 0.6, 1],
  blue: [0.15, 0.39, 0.92, 1],
  purple: [0.55, 0.25, 0.85, 1],
  grey: [0.55, 0.55, 0.58, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;
export type SceneColour = keyof typeof SCENE_PALETTE;
const COLOURS = Object.keys(SCENE_PALETTE) as SceneColour[];

export const SCENE_UNITS = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 } as const;
export type SceneUnit = keyof typeof SCENE_UNITS;
const UNITS = Object.keys(SCENE_UNITS) as SceneUnit[];

export type Vec3 = [number, number, number];

export interface ColourGroup { label: string; colour: SceneColour; targets: SceneTarget[] }

export type SceneAction =
  | { type: 'select'; targets: SceneTarget[] }
  | { type: 'isolate'; targets: SceneTarget[] }
  | { type: 'hide'; targets: SceneTarget[] }
  | { type: 'colour'; groups: ColourGroup[] }
  | { type: 'frame'; targets: SceneTarget[] }
  /** The side the normal points towards is cut away. */
  | { type: 'section'; units: SceneUnit; plane: { origin: Vec3; normal: Vec3 } }
  /** Everything outside the box is cut away. */
  | { type: 'section'; units: SceneUnit; box: { min: Vec3; max: Vec3 } }
  | { type: 'camera'; units: SceneUnit; eye: Vec3; target: Vec3 };

export type SceneActionType = SceneAction['type'];

export interface SceneActionSet {
  version: 1;
  kind: 'scene.actions';
  title: string;
  rationale?: string;
  actions: SceneAction[];
}

const SCENE_ACTION_LIMIT = 12;
export const SCENE_TARGET_LIMIT = 2000;
const SCENE_TOTAL_TARGET_LIMIT = 5000;
const TEXT_LIMIT = 2000;
const COORDINATE_LIMIT = 1e9;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;
const CITATION = /^E[1-9][0-9]{0,3}$/;

function targets(value: unknown, at: string): SceneTarget[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${at} needs at least one target`);
  if (value.length > SCENE_TARGET_LIMIT) throw new Error(`${at} may name at most ${SCENE_TARGET_LIMIT} targets`);
  const seen = new Set<string>();
  const out: SceneTarget[] = [];
  value.forEach((item, index) => {
    const where = `${at} target ${index + 1}`;
    if (!record(item)) throw new Error(`${where} is not an object`);
    let parsed: SceneTarget;
    if (item.citation !== undefined) {
      if (item.globalId !== undefined) throw new Error(`${where} must name either a GlobalId or a citation, not both`);
      if (typeof item.citation !== 'string' || !CITATION.test(item.citation)) throw new Error(`${where} citation must look like E1, E2, …`);
      parsed = { citation: item.citation };
    } else {
      if (typeof item.globalId !== 'string' || !GLOBAL_ID.test(item.globalId)) {
        throw new Error(`${where} needs a 22-character IFC GlobalId or an evidence citation`);
      }
      if (item.modelId !== undefined && !text(item.modelId)) throw new Error(`${where} model id must be text`);
      parsed = item.modelId === undefined ? { globalId: item.globalId } : { globalId: item.globalId, modelId: item.modelId as string };
    }
    const key = 'citation' in parsed ? `c:${parsed.citation}` : `g:${parsed.modelId ?? '*'}:${parsed.globalId}`;
    if (seen.has(key)) return; // a repeated target adds nothing; dropping it is not a reinterpretation
    seen.add(key);
    out.push(parsed);
  });
  return out;
}

function vec3(value: unknown, where: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${where} must be [x, y, z]`);
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${where} must contain finite numbers`);
    if (Math.abs(n) > COORDINATE_LIMIT) throw new Error(`${where} is out of range`);
  }
  return [value[0], value[1], value[2]];
}

function units(value: unknown, at: string): SceneUnit {
  if (typeof value !== 'string' || !UNITS.includes(value as SceneUnit)) {
    throw new Error(`${at} must state units: one of ${UNITS.join(', ')}`);
  }
  return value as SceneUnit;
}

function action(value: unknown, index: number): SceneAction {
  if (!record(value)) throw new Error(`Action ${index + 1} is not an object`);
  const at = `Action ${index + 1}`;
  // "color" is accepted as a spelling of the same action; it is not a different capability.
  const type = value.type === 'color' ? 'colour' : value.type;
  switch (type) {
    case 'select': case 'isolate': case 'hide': case 'frame':
      return { type, targets: targets(value.targets, `${at} (${type})`) };
    case 'colour': {
      if (!Array.isArray(value.groups) || value.groups.length === 0) throw new Error(`${at} (colour) needs at least one group`);
      if (value.groups.length > COLOURS.length) throw new Error(`${at} (colour) may have at most ${COLOURS.length} groups`);
      const used = new Set<string>();
      const groups = value.groups.map((group: unknown, g: number): ColourGroup => {
        const where = `${at} group ${g + 1}`;
        if (!record(group) || !text(group.label, 80)) throw new Error(`${where} needs a short label`);
        const colour = group.colour ?? group.color;
        if (typeof colour !== 'string' || !COLOURS.includes(colour as SceneColour)) {
          throw new Error(`${where} colour must be one of ${COLOURS.join(', ')}`);
        }
        if (used.has(colour)) throw new Error(`${where} reuses ${colour}; each group needs its own colour`);
        used.add(colour);
        return { label: group.label.trim(), colour: colour as SceneColour, targets: targets(group.targets, where) };
      });
      return { type: 'colour', groups };
    }
    case 'section': {
      const u = units(value.units, `${at} (section)`);
      if (record(value.plane) === record(value.box)) throw new Error(`${at} (section) needs exactly one of plane or box`);
      if (record(value.plane)) {
        const normal = vec3(value.plane.normal, `${at} plane normal`);
        if (Math.hypot(...normal) < 1e-9) throw new Error(`${at} plane normal must not be zero`);
        return { type: 'section', units: u, plane: { origin: vec3(value.plane.origin, `${at} plane origin`), normal } };
      }
      const box = value.box as Record<string, unknown>;
      const min = vec3(box.min, `${at} box min`);
      const max = vec3(box.max, `${at} box max`);
      if (min.some((v, i) => v >= max[i])) throw new Error(`${at} box min must be below max on every axis`);
      return { type: 'section', units: u, box: { min, max } };
    }
    case 'camera': {
      const u = units(value.units, `${at} (camera)`);
      const eye = vec3(value.eye, `${at} camera eye`);
      const target = vec3(value.target, `${at} camera target`);
      if (Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]) < 1e-6) throw new Error(`${at} camera eye and target must differ`);
      return { type: 'camera', units: u, eye, target };
    }
    default:
      throw new Error(`${at} has an unsupported type; use select, isolate, hide, colour, frame, section or camera`);
  }
}

/** Every target an action names. */
function actionTargets(item: SceneAction): SceneTarget[] {
  if (item.type === 'colour') return item.groups.flatMap(group => group.targets);
  return 'targets' in item ? item.targets : [];
}

/** Strict, bounded parse of a complete JSON answer (optionally fenced). Throws with a reason a person can act on. */
export function parseSceneActions(answer: string): SceneActionSet {
  if (answer.length > 400_000) throw new Error('The scene action set exceeds the text limit');
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch (error) { throw new Error(`The scene action set is not valid JSON (${error instanceof Error ? error.message : String(error)})`); }
  if (!record(value) || value.version !== 1 || value.kind !== 'scene.actions') throw new Error('Not a scene action set');
  if (!text(value.title)) throw new Error('A scene action set needs a short title');
  if (value.rationale !== undefined && !text(value.rationale, TEXT_LIMIT)) throw new Error('The rationale must be text');
  if (!Array.isArray(value.actions) || value.actions.length === 0) throw new Error('A scene action set needs at least one action');
  if (value.actions.length > SCENE_ACTION_LIMIT) throw new Error(`A scene action set may hold at most ${SCENE_ACTION_LIMIT} actions`);
  const actions = value.actions.map(action);
  const count = (type: SceneActionType) => actions.filter(item => item.type === type).length;
  for (const type of ['select', 'isolate', 'hide', 'colour', 'section', 'camera', 'frame'] as const) {
    if (count(type) > 1) throw new Error(`Combine the ${type} actions into one; a set may hold only one of each`);
  }
  if (count('frame') && count('camera')) throw new Error('Use either frame or camera; both move the camera');
  const total = actions.reduce((sum, item) => sum + actionTargets(item).length, 0);
  if (total > SCENE_TOTAL_TARGET_LIMIT) throw new Error(`A scene action set may name at most ${SCENE_TOTAL_TARGET_LIMIT} targets in total`);
  return { version: 1, kind: 'scene.actions', title: value.title.trim(),
    ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}), actions };
}

/** Guidance for providers: the exact contract, kept short so it fits beside evidence. */
export const SCENE_ACTION_OUTPUT_GUIDANCE =
  'When asked to show, select, isolate, hide, colour, frame or section elements, return only JSON '
  + '{"version":1,"kind":"scene.actions","title":"Short title","rationale":"Why","actions":[{"type":"isolate","targets":[{"citation":"E1"},'
  + '{"globalId":"<22-char GlobalId>"}]},{"type":"colour","groups":[{"label":"Failing","colour":"red","targets":[{"citation":"E2"}]}]},'
  + '{"type":"frame","targets":[{"citation":"E1"}]}]}. Types: select, isolate, hide, frame (targets), colour (groups; colours: '
  + `${COLOURS.join(', ')}), section ({"units":"m","plane":{"origin":[x,y,z],"normal":[x,y,z]}} cuts away the side the normal points to, `
  + 'or {"units":"m","box":{"min":[..],"max":[..]}}), camera ({"units":"m","eye":[..],"target":[..]}). Coordinates are IFC world '
  + 'coordinates, Z up, in the stated units; only use coordinates that appear in the evidence. Targets are GlobalIds or citations of '
  + 'supplied rows; never invent identifiers. The user previews and applies the actions and can restore the previous view.';
