/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC-OPS: a small formal op-program DSL over @ifc-lite/create (M5 bet B2.3).
 *
 * A program is a JSON array of ops. Every op is validated against a strict
 * schema (field names, types, ranges) plus semantic rules evaluated against
 * the program state built so far (reference existence, geometric fit of
 * openings, no opening overlap). The constrained decoding harness only ever
 * accepts ops that pass `validateOp`, and `applyOp` updates the state, so a
 * fully accepted program is grammar-valid by construction and maps 1:1 onto
 * @ifc-lite/create calls (see compile.mjs).
 *
 * Units are metres. X east, Y north, Z up. Element coordinates are
 * storey-local: z = 0 is the storey elevation.
 */

export const LIMITS = {
  maxOps: 80,
  maxCoord: 1000,
  minDim: 0.01,
  maxDim: 100,
  minWallLength: 0.3,
  edgeMargin: 0.05,
};

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Fresh validation state for one program. */
export function newState() {
  return {
    opCount: 0,
    storeys: new Map(),
    walls: new Map(),
    elements: new Map(),
  };
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPoint3(v) {
  return Array.isArray(v) && v.length === 3 && v.every(isNum);
}

function err(message) {
  return { ok: false, error: message };
}

const OK = { ok: true };

function checkId(state, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    return err(`"id" must be a string matching ${ID_RE} (got ${JSON.stringify(id)})`);
  }
  if (state.storeys.has(id) || state.walls.has(id) || state.elements.has(id)) {
    return err(`id "${id}" is already used by an earlier op; ids must be unique`);
  }
  return OK;
}

function checkDim(name, v, max = LIMITS.maxDim) {
  if (!isNum(v)) return err(`"${name}" must be a finite number (got ${JSON.stringify(v)})`);
  if (v <= LIMITS.minDim || v > max) {
    return err(`"${name}" must be in (${LIMITS.minDim}, ${max}] metres (got ${v})`);
  }
  return OK;
}

function checkPoint(name, v) {
  if (!isPoint3(v)) return err(`"${name}" must be [x, y, z] with finite numbers (got ${JSON.stringify(v)})`);
  for (const c of v) {
    if (Math.abs(c) > LIMITS.maxCoord) return err(`"${name}" coordinate ${c} exceeds |${LIMITS.maxCoord}| m`);
  }
  return OK;
}

function checkStoreyRef(state, op) {
  if (typeof op.storey !== 'string' || !state.storeys.has(op.storey)) {
    const known = [...state.storeys.keys()].join(', ') || '(none created yet)';
    return err(`"storey" must reference an existing create_storey id; got ${JSON.stringify(op.storey)}, known storeys: ${known}`);
  }
  return OK;
}

function checkNoExtraFields(op, allowed) {
  for (const k of Object.keys(op)) {
    if (!allowed.includes(k)) {
      return err(`unknown field "${k}" on op "${op.op}"; allowed fields: ${allowed.join(', ')}`);
    }
  }
  return OK;
}

function wallLength(w) {
  const dx = w.end[0] - w.start[0];
  const dy = w.end[1] - w.start[1];
  return Math.hypot(dx, dy);
}

/** Fit + overlap rules for a hosted opening (window/door). */
function checkOpeningFit(state, op, base) {
  const wall = state.walls.get(op.wall);
  if (!wall) {
    const known = [...state.walls.keys()].join(', ') || '(none created yet)';
    return err(`"wall" must reference an existing create_wall id; got ${JSON.stringify(op.wall)}, known walls: ${known}`);
  }
  const L = wallLength(wall);
  const m = LIMITS.edgeMargin;
  const lo = op.along - op.width / 2;
  const hi = op.along + op.width / 2;
  if (!(lo >= m && hi <= L - m)) {
    return err(`opening does not fit along wall "${op.wall}": centre ${op.along} +- ${op.width / 2} must lie within [${m}, ${(L - m).toFixed(3)}] (wall length ${L.toFixed(3)} m)`);
  }
  const top = base + op.height;
  if (!(base >= 0 && top <= wall.height - m)) {
    return err(`opening does not fit vertically in wall "${op.wall}": base ${base} + height ${op.height} must lie within [0, ${(wall.height - m).toFixed(3)}] (wall height ${wall.height} m)`);
  }
  for (const o of wall.openings) {
    const overlapH = lo < o.hi && hi > o.lo;
    const overlapV = base < o.top && top > o.base;
    if (overlapH && overlapV) {
      return err(`opening overlaps existing opening "${o.id}" on wall "${op.wall}" (along [${o.lo.toFixed(2)}, ${o.hi.toFixed(2)}], height [${o.base.toFixed(2)}, ${o.top.toFixed(2)}])`);
    }
  }
  return OK;
}

const VALIDATORS = {
  create_storey(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'name', 'elevation']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    if (typeof op.name !== 'string' || op.name.length === 0 || op.name.length > 64) {
      return err('"name" must be a non-empty string (max 64 chars)');
    }
    if (!isNum(op.elevation) || op.elevation < -50 || op.elevation > 500) {
      return err(`"elevation" must be a finite number in [-50, 500] (got ${JSON.stringify(op.elevation)})`);
    }
    for (const [sid, s] of state.storeys) {
      if (s.elevation === op.elevation) {
        return err(`elevation ${op.elevation} is already used by storey "${sid}"; storeys need distinct elevations`);
      }
    }
    return OK;
  },

  create_slab(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'storey', 'position', 'width', 'depth', 'thickness']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    r = checkStoreyRef(state, op);
    if (!r.ok) return r;
    r = checkPoint('position', op.position);
    if (!r.ok) return r;
    for (const [k, max] of [['width', LIMITS.maxDim], ['depth', LIMITS.maxDim], ['thickness', 2]]) {
      r = checkDim(k, op[k], max);
      if (!r.ok) return r;
    }
    return OK;
  },

  create_wall(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'storey', 'start', 'end', 'thickness', 'height']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    r = checkStoreyRef(state, op);
    if (!r.ok) return r;
    r = checkPoint('start', op.start);
    if (!r.ok) return r;
    r = checkPoint('end', op.end);
    if (!r.ok) return r;
    for (const [k, max] of [['thickness', 2], ['height', 20]]) {
      r = checkDim(k, op[k], max);
      if (!r.ok) return r;
    }
    const L = Math.hypot(op.end[0] - op.start[0], op.end[1] - op.start[1]);
    if (L < LIMITS.minWallLength) {
      return err(`wall axis length ${L.toFixed(3)} m is below the minimum ${LIMITS.minWallLength} m`);
    }
    if (op.start[2] !== op.end[2]) {
      return err(`wall start z (${op.start[2]}) and end z (${op.end[2]}) must be equal (horizontal axis)`);
    }
    return OK;
  },

  add_window(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'wall', 'along', 'sill', 'width', 'height']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    for (const k of ['width', 'height']) {
      r = checkDim(k, op[k], 20);
      if (!r.ok) return r;
    }
    if (!isNum(op.along) || !isNum(op.sill) || op.sill < 0) {
      return err('"along" must be a finite number and "sill" a finite number >= 0');
    }
    return checkOpeningFit(state, op, op.sill);
  },

  add_door(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'wall', 'along', 'width', 'height']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    for (const k of ['width', 'height']) {
      r = checkDim(k, op[k], 20);
      if (!r.ok) return r;
    }
    if (!isNum(op.along)) return err('"along" must be a finite number');
    return checkOpeningFit(state, op, 0);
  },

  create_column(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'storey', 'position', 'width', 'depth', 'height']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    r = checkStoreyRef(state, op);
    if (!r.ok) return r;
    r = checkPoint('position', op.position);
    if (!r.ok) return r;
    for (const [k, max] of [['width', 5], ['depth', 5], ['height', 20]]) {
      r = checkDim(k, op[k], max);
      if (!r.ok) return r;
    }
    return OK;
  },

  create_beam(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'storey', 'start', 'end', 'width', 'height']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    r = checkStoreyRef(state, op);
    if (!r.ok) return r;
    r = checkPoint('start', op.start);
    if (!r.ok) return r;
    r = checkPoint('end', op.end);
    if (!r.ok) return r;
    for (const [k, max] of [['width', 5], ['height', 5]]) {
      r = checkDim(k, op[k], max);
      if (!r.ok) return r;
    }
    const L = Math.hypot(op.end[0] - op.start[0], op.end[1] - op.start[1], op.end[2] - op.start[2]);
    if (L < 0.1) return err(`beam axis length ${L.toFixed(3)} m is below the minimum 0.1 m`);
    return OK;
  },

  create_space(state, op) {
    let r = checkNoExtraFields(op, ['op', 'id', 'storey', 'name', 'position', 'width', 'depth', 'height']);
    if (!r.ok) return r;
    r = checkId(state, op.id);
    if (!r.ok) return r;
    r = checkStoreyRef(state, op);
    if (!r.ok) return r;
    if (typeof op.name !== 'string' || op.name.length === 0 || op.name.length > 64) {
      return err('"name" must be a non-empty string (max 64 chars)');
    }
    r = checkPoint('position', op.position);
    if (!r.ok) return r;
    for (const [k, max] of [['width', LIMITS.maxDim], ['depth', LIMITS.maxDim], ['height', 20]]) {
      r = checkDim(k, op[k], max);
      if (!r.ok) return r;
    }
    return OK;
  },

  set_property(state, op) {
    const r = checkNoExtraFields(op, ['op', 'target', 'pset', 'name', 'value']);
    if (!r.ok) return r;
    const known = state.walls.has(op.target) || state.elements.has(op.target);
    if (typeof op.target !== 'string' || !known) {
      return err(`"target" must reference an existing element id (walls, slabs, columns, beams, windows, doors, spaces); got ${JSON.stringify(op.target)}`);
    }
    if (typeof op.pset !== 'string' || op.pset.length === 0 || op.pset.length > 64) {
      return err('"pset" must be a non-empty string (max 64 chars)');
    }
    if (typeof op.name !== 'string' || op.name.length === 0 || op.name.length > 64) {
      return err('"name" must be a non-empty string (max 64 chars)');
    }
    const t = typeof op.value;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      return err('"value" must be a string, number, or boolean');
    }
    if (t === 'number' && !Number.isFinite(op.value)) return err('"value" must be finite');
    return OK;
  },
};

export const OP_NAMES = Object.keys(VALIDATORS);

/**
 * Validate one op against the schema and the state accumulated so far.
 * Pure: does not mutate state.
 */
export function validateOp(state, op) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    return err(`each op must be a JSON object (got ${JSON.stringify(op)?.slice(0, 60)})`);
  }
  if (typeof op.op !== 'string' || !VALIDATORS[op.op]) {
    return err(`unknown op ${JSON.stringify(op.op)}; valid ops: ${OP_NAMES.join(', ')}`);
  }
  if (state.opCount >= LIMITS.maxOps) {
    return err(`program exceeds the maximum of ${LIMITS.maxOps} ops`);
  }
  return VALIDATORS[op.op](state, op);
}

/** Apply a VALIDATED op to the state. Call only after validateOp returned ok. */
export function applyOp(state, op) {
  state.opCount += 1;
  switch (op.op) {
    case 'create_storey':
      state.storeys.set(op.id, { name: op.name, elevation: op.elevation });
      break;
    case 'create_wall':
      state.walls.set(op.id, {
        storey: op.storey,
        start: op.start,
        end: op.end,
        thickness: op.thickness,
        height: op.height,
        openings: [],
      });
      break;
    case 'add_window':
    case 'add_door': {
      const wall = state.walls.get(op.wall);
      const base = op.op === 'add_window' ? op.sill : 0;
      wall.openings.push({
        id: op.id,
        lo: op.along - op.width / 2,
        hi: op.along + op.width / 2,
        base,
        top: base + op.height,
      });
      state.elements.set(op.id, { kind: op.op === 'add_window' ? 'window' : 'door' });
      break;
    }
    case 'set_property':
      break;
    default:
      state.elements.set(op.id, { kind: op.op.replace('create_', '') });
      break;
  }
}

/** Human-readable state summary fed back to the model in repair prompts. */
export function describeState(state) {
  const storeys = [...state.storeys.entries()]
    .map(([id, s]) => `${id} (elevation ${s.elevation})`);
  const walls = [...state.walls.entries()].map(([id, w]) => {
    const L = wallLength(w);
    return `${id} (length ${L.toFixed(2)}, height ${w.height}, thickness ${w.thickness}, openings ${w.openings.length})`;
  });
  const kinds = {};
  for (const e of state.elements.values()) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  return [
    `storeys: ${storeys.join('; ') || 'none'}`,
    `walls: ${walls.join('; ') || 'none'}`,
    `other elements: ${Object.entries(kinds).map(([k, n]) => `${k} x${n}`).join(', ') || 'none'}`,
  ].join('\n');
}

/**
 * The DSL specification text embedded in every prompt (both arms see the
 * exact same spec, so the only difference between arms is the feedback loop).
 */
export const DSL_SPEC = `IFC-OPS DSL. A program is a JSON array of op objects. Units metres; X east, Y north, Z up.
Element coordinates are STOREY-LOCAL: z=0 is the storey's elevation. Ids: lowercase [a-z][a-z0-9_-]*, unique across the program.

Ops (all fields required, no extra fields allowed):
1 {"op":"create_storey","id":ID,"name":S,"elevation":N}
   One per floor, distinct elevations. Must be created before elements reference it.
2 {"op":"create_slab","id":ID,"storey":SID,"position":[x,y,z],"width":W,"depth":D,"thickness":T}
   position = MIN corner; slab occupies [x,x+W] x [y,y+D] x [z,z+T].
3 {"op":"create_wall","id":ID,"storey":SID,"start":[x,y,z],"end":[x,y,z],"thickness":T,"height":H}
   Straight wall along axis start->end (same z, length >= 0.3), extrudes up by H from z.
4 {"op":"add_window","id":ID,"wall":WID,"along":A,"sill":S,"width":W,"height":H}
   Window centred A metres from the wall's start along its axis, base at sill height S.
   Fit rules: A-W/2 >= 0.05 and A+W/2 <= wallLength-0.05; S >= 0; S+H <= wallHeight-0.05.
   Openings on one wall must not overlap.
5 {"op":"add_door","id":ID,"wall":WID,"along":A,"width":W,"height":H}
   Like add_window but base is the wall bottom (sill 0). Same fit rules with S=0.
6 {"op":"create_column","id":ID,"storey":SID,"position":[x,y,z],"width":W,"depth":D,"height":H}
   position = centre of the rectangular section at the base.
7 {"op":"create_beam","id":ID,"storey":SID,"start":[x,y,z],"end":[x,y,z],"width":W,"height":H}
   Axis start->end at the section centre.
8 {"op":"create_space","id":ID,"storey":SID,"name":S,"position":[x,y,z],"width":W,"depth":D,"height":H}
   Room volume; position = MIN corner (like create_slab).
9 {"op":"set_property","target":EID,"pset":S,"name":S,"value":S|N|BOOL}
   Attach a property to an earlier element (not a storey).

Numeric limits: |coordinates| <= 1000; thickness <= 2; heights <= 20; other dims <= 100; max 80 ops.
Typical composition: slab position [0,0,0] with walls on its top face (start/end z = slab thickness) placed along the slab edges (wall axis is the wall centreline).

Example, one storey with a slab, one wall with a window:
[{"op":"create_storey","id":"s1","name":"Ground","elevation":0},
 {"op":"create_slab","id":"slab1","storey":"s1","position":[0,0,0],"width":8,"depth":6,"thickness":0.2},
 {"op":"create_wall","id":"w1","storey":"s1","start":[0,0.1,0.2],"end":[8,0.1,0.2],"thickness":0.2,"height":3},
 {"op":"add_window","id":"win1","wall":"w1","along":4,"sill":0.9,"width":1.2,"height":1.4}]`;
