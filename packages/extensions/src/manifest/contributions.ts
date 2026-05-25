/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-contribution-type validators. Each slot type has its own validator
 * because the required fields differ. Slot id allow-lists are kept here
 * (single source of truth alongside the validators).
 */

import { parseWhen } from '../when/parse.js';
import {
  ValidationContext,
  isPlainObject,
  requireStringInObj,
  validateArray,
} from './primitives.js';

const TOOLBAR_SLOTS = new Set(['toolbar.left', 'toolbar.right', 'toolbar.center']);
const DOCK_SLOTS = new Set(['dock.left', 'dock.right', 'dock.bottom']);
const CONTEXT_MENU_SLOTS = new Set([
  'contextMenu.entity',
  'contextMenu.canvas',
  'contextMenu.tree',
]);
const STATUS_BAR_SLOTS = new Set(['statusBar.left', 'statusBar.right']);

export function validateContributions(
  ctx: ValidationContext,
  raw: unknown,
  path: string,
): void {
  if (!isPlainObject(raw)) {
    ctx.add(path, 'type_mismatch', 'contributes must be an object.');
    return;
  }
  const obj = raw as Record<string, unknown>;

  if ('commands' in obj && obj.commands !== undefined) {
    validateArray(ctx, obj.commands, `${path}.commands`, (item, p) => {
      requireStringInObj(ctx, item, p, 'id');
      requireStringInObj(ctx, item, p, 'title');
    });
  }
  if ('toolbar' in obj && obj.toolbar !== undefined) {
    validateArray(ctx, obj.toolbar, `${path}.toolbar`, (item, p) => {
      requireStringInObj(ctx, item, p, 'command');
      validateSlot(ctx, item, p, TOOLBAR_SLOTS, 'toolbar');
      validateOptionalWhen(ctx, item, p);
    });
  }
  if ('dock' in obj && obj.dock !== undefined) {
    validateArray(ctx, obj.dock, `${path}.dock`, (item, p) => {
      requireStringInObj(ctx, item, p, 'id');
      requireStringInObj(ctx, item, p, 'title');
      requireStringInObj(ctx, item, p, 'widget');
      validateSlot(ctx, item, p, DOCK_SLOTS, 'dock');
      validateOptionalWhen(ctx, item, p);
    });
  }
  if ('contextMenu' in obj && obj.contextMenu !== undefined) {
    validateArray(ctx, obj.contextMenu, `${path}.contextMenu`, (item, p) => {
      requireStringInObj(ctx, item, p, 'command');
      validateSlot(ctx, item, p, CONTEXT_MENU_SLOTS, 'contextMenu');
      validateOptionalWhen(ctx, item, p);
    });
  }
  if ('keybindings' in obj && obj.keybindings !== undefined) {
    validateArray(ctx, obj.keybindings, `${path}.keybindings`, (item, p) => {
      requireStringInObj(ctx, item, p, 'command');
      requireStringInObj(ctx, item, p, 'key');
      validateOptionalWhen(ctx, item, p);
    });
  }
  if ('lenses' in obj && obj.lenses !== undefined) {
    validateArray(ctx, obj.lenses, `${path}.lenses`, (item, p) => {
      requireStringInObj(ctx, item, p, 'id');
      requireStringInObj(ctx, item, p, 'name');
      requireStringInObj(ctx, item, p, 'evaluator');
    });
  }
  if ('exporters' in obj && obj.exporters !== undefined) {
    validateArray(ctx, obj.exporters, `${path}.exporters`, (item, p) => {
      requireStringInObj(ctx, item, p, 'id');
      requireStringInObj(ctx, item, p, 'name');
      requireStringInObj(ctx, item, p, 'mimeType');
      requireStringInObj(ctx, item, p, 'extension');
      requireStringInObj(ctx, item, p, 'handler');
    });
  }
  if ('idsValidators' in obj && obj.idsValidators !== undefined) {
    validateArray(ctx, obj.idsValidators, `${path}.idsValidators`, (item, p) => {
      requireStringInObj(ctx, item, p, 'id');
      requireStringInObj(ctx, item, p, 'name');
      requireStringInObj(ctx, item, p, 'handler');
    });
  }
  if ('statusBar' in obj && obj.statusBar !== undefined) {
    validateArray(ctx, obj.statusBar, `${path}.statusBar`, (item, p) => {
      requireStringInObj(ctx, item, p, 'id');
      requireStringInObj(ctx, item, p, 'text');
      validateSlot(ctx, item, p, STATUS_BAR_SLOTS, 'statusBar');
      validateOptionalWhen(ctx, item, p);
    });
  }
}

function validateSlot(
  ctx: ValidationContext,
  item: unknown,
  path: string,
  allowed: ReadonlySet<string>,
  group: string,
): void {
  if (!isPlainObject(item)) return;
  const slot = (item as Record<string, unknown>).slot;
  if (typeof slot !== 'string' || !allowed.has(slot)) {
    ctx.add(`${path}.slot`, 'invalid_slot',
      `Invalid ${group} slot ${JSON.stringify(slot)}.`,
      `Allowed: ${Array.from(allowed).join(', ')}.`);
  }
}

function validateOptionalWhen(
  ctx: ValidationContext,
  item: unknown,
  path: string,
): void {
  if (!isPlainObject(item)) return;
  const v = (item as Record<string, unknown>).when;
  if (v === undefined) return;
  if (typeof v !== 'string') {
    ctx.add(`${path}.when`, 'type_mismatch', 'when must be a string.');
    return;
  }
  const parsed = parseWhen(v);
  if (!parsed.ok) {
    for (const err of parsed.errors) {
      ctx.add(`${path}.when`, err.code, err.message, err.hint);
    }
  }
}
