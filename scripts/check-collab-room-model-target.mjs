#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: everything that crosses a collab room's boundary must address the ROOM
 * model by id — never "whatever model is active" (#2705, and the edit paths).
 *
 * `setIfcDataStore` / `setGeometryResult` and the top-level `ifcDataStore`
 * track `activeModelId` (dataSlice.ts), and `upsertModel` keeps the existing
 * `activeModelId` rather than switching to the model it creates
 * (modelSlice.ts). So a user who joins a room and then loads and selects their
 * own file — two clicks — has a different model active, and every path that
 * said "active" meant the wrong model:
 *
 *   1. the recipient's `reconstruct` replaced the user's own store and meshes
 *      with the room's on the next peer edit (#2705; repaired by a reload);
 *   2. inbound peer edits were replayed into the user's own model's view under
 *      a room-id-space expressId, landing in that view's overlay and
 *      `mutationHistory` — the export path (survives a reload);
 *   3. outbound, the user's edits on their PRIVATE model were mirrored into the
 *      shared room and applied to whatever entity the id resolved to there.
 *
 * The fixes are `applyRoomModelData` (room-model-apply.ts) and the resolvers in
 * room-model-target.ts, both unit-tested. THIS file pins the wiring, which is
 * the half that was wrong and the half no test holds: reverting the call sites
 * leaves `tsc --noEmit` clean and the whole viewer suite green, because the
 * collab session path needs jsdom, module mocking, `import.meta.env`,
 * IndexedDB and a websocket and so cannot be driven under `tsx --test`.
 *
 * An absence claim over a few regions of two files is a lint, not a unit test,
 * so it lives here — `scripts/check-source-text-assertions.mjs` forbids exactly
 * this shape inside a test file, and `check-unbounded-frame-wait.mjs` /
 * `check-wasm-disposal.mjs` are the same shape for the same reason.
 *
 * Every check below fails closed: a region that cannot be located, or that no
 * longer routes through the by-id helper, is an error rather than a silent
 * pass. An absence guard that scans nothing passes forever.
 *
 * The outbound checks (3 and 4) are STRUCTURAL rather than a text scan for a
 * remembered pattern, because the earlier "somewhere in this file there is at
 * least one gate" shape was evadable in exactly the way it existed to prevent —
 * a gate could be deleted from most call sites, or aliased past
 * (`const st = get;`), and still pass. Instead:
 *
 *   - the set of actions to check is ENUMERATED from the source, keyed on
 *     "takes an entityId", so a newly added mirror is covered on the day it is
 *     written rather than the day someone updates this file;
 *   - each one must both TAKE a `modelId` and resolve through the single call
 *     that binds the store to it, so the gate cannot be half-performed;
 *   - every call site is checked, not just one, and the per-action counts are
 *     floored so a deletion is a deliberate diff.
 *
 * Run via `node scripts/check-collab-room-model-target.mjs` (CI node-test job).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const COLLAB_SLICE = 'apps/viewer/src/store/slices/collabSlice.ts';
const MUTATION_SLICE = 'apps/viewer/src/store/slices/mutationSlice.ts';

/**
 * Blank out comments so a `//`-quoted symbol (these regions document exactly
 * the shapes being banned) doesn't read as code, and single/double-quoted
 * strings so a stray brace in a literal can't desync the region scan. Template
 * literals are left alone: their `${...}` braces are balanced.
 */
function blankNoise(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i];
      out += quote;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

const failures = [];

/** Record a failure; the run reports all of them before exiting once. */
function fail(lines) {
  failures.push(lines);
}

/** Load a file once, comment/string-blanked, with a raw copy for line numbers. */
function load(rel) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  return {
    rel,
    raw,
    clean: blankNoise(raw),
    lineOf(offset) {
      return raw.slice(0, offset).split('\n').length;
    },
  };
}

/**
 * Delimit a brace-balanced region starting at `marker`. Returns `null` after
 * recording the failure, so a renamed region breaks the build rather than
 * quietly shrinking the scan to nothing.
 */
function region(file, marker, label) {
  const start = file.clean.indexOf(marker);
  if (start === -1) {
    fail([
      `${label}: could not find \`${marker.split('\n')[0]}\` in ${file.rel}.`,
      '',
      'The region this guard pins was renamed or removed, so nothing was checked.',
      'Re-point the guard at whatever replaced it.',
    ]);
    return null;
  }
  const bodyStart = file.clean.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < file.clean.length; i += 1) {
    if (file.clean[i] === '{') depth += 1;
    else if (file.clean[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          label,
          text: file.clean.slice(start, i + 1),
          offset: start,
          first: file.lineOf(start),
          last: file.lineOf(i),
          file,
        };
      }
    }
  }
  fail([
    `${label}: unbalanced braces after \`${marker.split('\n')[0]}\` in ${file.rel}.`,
    '',
    'Could not delimit the region, so nothing was checked.',
  ]);
  return null;
}

/**
 * The two halves of every check: the banned shapes must be absent, and at least
 * one by-id call must be present. The second half is what stops the first from
 * being satisfied by deleting the code.
 */
function assertRegion(reg, { banned, required, consequence }) {
  if (!reg) return;
  const hits = [];
  for (const needle of banned) {
    let at = reg.text.indexOf(needle);
    while (at !== -1) {
      hits.push(`${reg.file.rel}:${reg.file.lineOf(reg.offset + at)}: ${needle}…`);
      at = reg.text.indexOf(needle, at + 1);
    }
  }
  if (hits.length > 0) {
    fail([`${reg.label} resolves the room's model as the ACTIVE model:`, '', ...hits.map((h) => `  ${h}`), '', consequence]);
    return;
  }
  for (const needle of required) {
    if (!reg.text.includes(needle)) {
      fail([
        `${reg.label}: no \`${needle}\` in ${reg.file.rel}:${reg.first}-${reg.last}.`,
        '',
        'The region no longer routes through the by-id resolver, so "does not use',
        'the active model" is satisfied vacuously. Restore the call, or re-point',
        'this guard at whatever replaced it.',
      ]);
    }
  }
}

const collab = load(COLLAB_SLICE);
const mutation = load(MUTATION_SLICE);

// ── 1. The recipient's re-derivation (#2705) ────────────────────────────────
assertRegion(region(collab, 'const reconstruct = async () => {', 'collab recipient reconstruct'), {
  banned: ['get().setIfcDataStore(', 'get().setGeometryResult('],
  required: ['applyRoomModelData('],
  consequence: `Those setters target \`activeModelId\`, but the reconstruct's target is the room
model: a recipient with their own file active loses that file's store and
meshes on the next peer edit. Route the write through
\`applyRoomModelData(get(), roomModelId, { … })\`
(apps/viewer/src/lib/collab/room-model-apply.ts).`,
});

// ── 2. Inbound: a peer's edit replayed into a local view ────────────────────
//
// The banned members are matched WITHOUT their receiver (`.activeModelId`, not
// `get().activeModelId`): banning the `get()` spelling only is evaded by
// `const st = get;` … `st().ifcDataStore`, which is the same read with a
// different name. These three fields have no legitimate reader in this region —
// the room's equivalents are `roomModelIdOf` / `roomStore` / `roomMutationView`
// — while `.models` (used for `toGlobalIdFromModels`) is model-agnostic and
// stays allowed.
assertRegion(region(collab, 'remoteApplyTeardown = attachRemoteApply(', 'collab inbound apply'), {
  banned: ['.activeModelId', '.ifcDataStore', '.mutationViews'],
  required: ['roomStore(get())', 'roomMutationView(get())', 'roomModelIdOf(get())'],
  consequence: `A peer's edit carries an expressId in the ROOM's id space. Replaying it into
the ACTIVE model writes it into the user's own file — into that model's view
overlay and mutationHistory, i.e. the export path, where it survives a reload
and ships in their exported IFC. Resolve through \`roomStore\` / \`roomMutationView\` /
\`roomModelIdOf\` (apps/viewer/src/lib/collab/room-model-target.ts).`,
});

// ── 2b. The shared mesh reconciler the inbound region CALLS ────────────────
//
// `reconcilePlacementMesh` is a module-level helper, so it sits OUTSIDE every
// region above even though the inbound apply's `onPlacement` and three of the
// slice's own actions all funnel through it. That is exactly how it kept
// `get().activeModelId` and `get().geometryResult` through the fix: check 2
// scans the handler, and the handler is one call long.
//
// The consequence is the defect this guard exists to prevent, one layer down.
// The reconstructed room model is registered with `idOffset: 0` while a
// recipient's own file generally has a non-zero offset, so with their own file
// active a DELIVERED placement edit is turned into a globalId of the wrong
// model — it moves an unrelated mesh, or none. Same for the rotate pivot, which
// reads the bbox centre out of the active model's meshes.
//
// A region that no longer exists fails closed via `region`, so extracting this
// helper into its own module means re-pointing the guard, not dropping it.
assertRegion(region(collab, 'function reconcilePlacementMesh(', 'collab placement reconciler'), {
  banned: ['.activeModelId', 'get().geometryResult'],
  required: ['roomModelIdOf(get())', 'roomMeshes(get())'],
  consequence: `The mesh this moves is addressed by \`globalId\`, which is \`idOffset + expressId\`
of a NAMED model. The room's reconstructed model has \`idOffset: 0\` and the
user's own file generally does not, so resolving against the ACTIVE model moves
the wrong mesh — or none — for a peer edit that was delivered correctly.
Resolve through \`roomModelIdOf\` / \`roomMeshes\`
(apps/viewer/src/lib/collab/room-model-target.ts).`,
});

// ── 3. Outbound: every entity action gates itself, by construction ─────────
//
// The rule, and the reason this is discovered rather than listed: an expressId
// is meaningless without the model whose id space it belongs to, so a collab
// action that takes an `entityId` MUST take a `modelId` too, and MUST resolve
// its store through `roomStoreFor(get(), modelId)` — the single call that is
// both the room gate and the store lookup.
//
// Doing the lookup without the gate is strictly worse than the bug it replaces:
// the room's `idToPath` is dense over its own ids, so a PRIVATE model's
// expressId resolves to a REAL path of the SHARED model, `hasEntity` says yes,
// and the write lands on an unrelated peer's entity. Resolving against the
// user's own store merely fails closed.
//
// Actions are ENUMERATED from the source, not listed here, so a new one is
// covered the day it is written rather than the day someone remembers to add it
// to this file. Actions with no `entityId` (the annotation mirrors, which are
// room-level markup) are room-scoped already and are correctly exempt.
const ENTITY_ACTION_RE = /\n {2}((?:mirror|collab|readCollab)[A-Za-z]*): \(([^)]*)\) => \{/g;
/** Every collab action in the slice implementation, with its parameter list. */
const collabActions = [];
for (const m of collab.clean.matchAll(ENTITY_ACTION_RE)) {
  const params = m[2].split(',').map((p) => p.trim()).filter(Boolean);
  collabActions.push({ name: m[1], params, header: m[0].slice(1), offset: m.index + 1 });
}
const entityActions = collabActions.filter((a) => a.params.includes('entityId'));

// Fail closed: if the shape of the slice changed enough that the scan finds
// (almost) nothing, "every action is gated" would be vacuously true.
const ENTITY_ACTION_FLOOR = 10;
if (entityActions.length < ENTITY_ACTION_FLOOR) {
  fail([
    `collab entity actions: found ${entityActions.length} in ${COLLAB_SLICE}, expected at least ${ENTITY_ACTION_FLOOR}.`,
    '',
    'This guard enumerates the actions it checks. Finding fewer than exist means',
    'the scan no longer matches the slice, so nothing meaningful was checked.',
    'Re-point the pattern, and lower this floor only alongside a real deletion.',
  ]);
}

for (const action of entityActions) {
  if (action.params[0] !== 'modelId') {
    fail([
      `collab ${action.name} takes an entityId but no leading modelId (${COLLAB_SLICE}:${collab.lineOf(action.offset)}).`,
      '',
      `  (${action.params.join(', ')})`,
      '',
      `An expressId only means something against the model it came from. Without
the modelId this action cannot tell a room edit from an edit on the user's own
file, and resolving it against the room's store writes a real path of the
SHARED model. Take \`modelId\` first and gate on
\`roomStoreFor(get(), modelId)\` (apps/viewer/src/lib/collab/room-model-target.ts).`,
    ]);
    continue;
  }
  assertRegion(region(collab, action.header, `collab ${action.name}`), {
    // The gate and the store lookup are one call, so naming either half
    // separately is the split this guard exists to prevent.
    banned: ['roomStore(get())', 'get().models.get(modelId)', 'get().ifcDataStore'],
    required: ['roomStoreFor(get(), modelId)'],
    consequence: `\`${action.name}\` resolves its store without binding it to \`modelId\`. Use
\`roomStoreFor(get(), modelId)\`, which returns the room's store ONLY when
\`modelId\` is the room's model — see its doc comment for why the lookup alone
is the dangerous half.`,
  });
}

// ── 4. The call sites hand over the EDITED model ───────────────────────────
//
// With the gate in the callee, the call site has exactly one job left, and
// getting it wrong re-opens the corruption one level up: passing
// `activeModelId` would make the gate approve a private model's edit. Every
// call is checked (not "at least one"), and the counts are floored so deleting
// a call site is a deliberate, visible diff rather than a free pass.
//
// `mutationSlice.collab-gate.test.ts` pins the same property behaviourally for
// the three property/attribute mirrors; this covers all of them.
const CALL_SITE_FLOOR = {
  mirrorPropertyEdit: 1,
  mirrorPropertyDelete: 1,
  mirrorAttributeEdit: 1,
  mirrorPlacementEdit: 3,
  mirrorEntityRemove: 1,
  mirrorEntityCreate: 2,
  mirrorEntityGeometry: 1,
  readCollabPlacement: 3,
  collabTranslateEntity: 2,
  collabRotateEntity: 1,
};
{
  const entityActionNames = new Set(entityActions.map((a) => a.name));
  const seen = new Map();
  const CALL_RE = /get\(\)\.((?:mirror|collab|readCollab)[A-Za-z]*)\(\s*([A-Za-z0-9_.()!]*)/g;
  for (const m of mutation.clean.matchAll(CALL_RE)) {
    const [, name, firstArg] = m;
    if (!entityActionNames.has(name)) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (firstArg !== 'modelId') {
      fail([
        `${MUTATION_SLICE}:${mutation.lineOf(m.index)}: \`${name}\` is handed \`${firstArg}\`, not \`modelId\`.`,
        '',
        `The room gate inside \`${name}\` trusts the modelId it is given. Handing it
anything but the model this edit was made ON — \`activeModelId\` above all —
approves mirroring a PRIVATE model's edit into the shared room, which is the
defect this guard exists to prevent.`,
      ]);
    }
  }
  for (const [name, floor] of Object.entries(CALL_SITE_FLOOR)) {
    const count = seen.get(name) ?? 0;
    if (count < floor) {
      fail([
        `collab call sites: \`${name}\` is called ${count}× in ${MUTATION_SLICE}, expected at least ${floor}.`,
        '',
        'A call site was removed or renamed. If the removal is deliberate, lower the',
        'floor in this guard in the same commit; otherwise an edit path silently',
        'stopped syncing to the room.',
      ]);
    }
  }
}

if (failures.length > 0) {
  for (const lines of failures) {
    console.error(`\n${lines.join('\n')}`);
  }
  console.error('');
  process.exit(1);
}

const callSiteTotal = Object.values(CALL_SITE_FLOOR).reduce((a, b) => a + b, 0);
console.log(
  `check-collab-room-model-target: OK (3 regions, ${entityActions.length} entity actions self-gated, ` +
    `${callSiteTotal} call sites bound to modelId)`,
);
