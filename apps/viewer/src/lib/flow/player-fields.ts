/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Player form fields (#5167 Phase 4.1): the same "read the declared inputs,
 * resolve each against the node's params" the CLI's `flow describe` /
 * `parseInputs` do, plus per-kind validation so a bad value blocks Run
 * instead of silently coercing (`'' -> 0`).
 *
 * One `PlayerField` per `doc.inputs` entry, in document order (the same
 * order the CLI reports and a graph author sees in the inspector). Errors
 * are i18n message keys (`flowPanel.player.error.*`), not English prose:
 * the component looks them up through the viewer's translation catalogue.
 */

import { validateTable, type FlowDocument, type FlowInput, type InputKind, type NodeRegistry, type ParamKind } from '@ifc-lite/flow';
import type { TranslatableMessage } from '@/i18n/types';

export interface PlayerField {
  /** `${nodeId}.${param}` — the key `runFlow`'s `inputs` option reads. */
  readonly key: string;
  readonly input: FlowInput;
  /** The node param this input binds to, when the node still exists in the registry. */
  readonly paramKind: ParamKind | undefined;
  /** Declared choices: the input's own `options`, else the param's. */
  readonly options: readonly string[];
  /** The value Run uses when the field is left blank. */
  readonly default: unknown;
}

export function playerFields(doc: FlowDocument, registry: NodeRegistry<unknown>): PlayerField[] {
  return doc.inputs.map((input) => {
    const node = doc.nodes.find((n) => n.id === input.nodeId);
    const def = node ? registry.get(node.type) : undefined;
    const param = def?.params.find((p) => p.name === input.param);
    return {
      key: `${input.nodeId}.${input.param}`,
      input,
      paramKind: param?.kind,
      options: input.options ?? param?.options ?? [],
      default: node?.params?.[input.param] ?? param?.default,
    };
  });
}

/**
 * The field's default, in the raw shape its widget edits — e.g. a `number`
 * scalar's numeric default becomes the string `"0"` a text `<input>` shows;
 * a `boolean` scalar's stays a real boolean for the checkbox. `undefined`
 * when the field declares no default (the widget then starts blank).
 * This is what "pre-filled from defaults" means for the Player form.
 */
export function seedPlayerValue(field: PlayerField): unknown {
  const { default: def } = field;
  switch (field.input.kind) {
    case 'scalar':
      switch (field.paramKind) {
        case 'boolean':
          return def === true;
        case 'number':
          return def === undefined ? undefined : String(def);
        case 'json':
        case 'code':
          return def === undefined ? undefined : typeof def === 'string' ? def : JSON.stringify(def);
        default:
          return typeof def === 'string' ? def : def === undefined ? undefined : String(def);
      }
    case 'enum':
    case 'storey':
      return typeof def === 'string' ? def : undefined;
    case 'entitySet':
      return Array.isArray(def) ? def.join('\n') : undefined;
    case 'table':
      return def === undefined ? undefined : JSON.stringify(def);
    case 'file':
    default:
      return undefined;
  }
}

export type PlayerValidation = { readonly ok: true; readonly value: unknown } | ({ readonly ok: false } & TranslatableMessage);

const ok = (value: unknown): PlayerValidation => ({ ok: true, value });
const err = (labelKey: TranslatableMessage['labelKey'], params?: Record<string, string>): PlayerValidation => ({ ok: false, labelKey, params });

function validateScalar(field: PlayerField, raw: unknown): PlayerValidation {
  switch (field.paramKind) {
    case 'boolean':
      return ok(raw === true);
    case 'number': {
      if (raw === '' || raw === undefined) {
        return field.default !== undefined ? ok(undefined) : err('flowPanel.player.error.required');
      }
      if (typeof raw !== 'string') return err('flowPanel.player.error.notNumber');
      const n = Number(raw);
      return Number.isFinite(n) ? ok(n) : err('flowPanel.player.error.notNumber');
    }
    case 'enum': {
      if (typeof raw !== 'string' || raw.length === 0) return err('flowPanel.player.error.selectValue');
      if (field.options.length > 0 && !field.options.includes(raw)) return err('flowPanel.player.error.notOneOf', { options: field.options.join(', ') });
      return ok(raw);
    }
    case 'json': {
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return field.default !== undefined ? ok(undefined) : err('flowPanel.player.error.enterJson');
      }
      try {
        return ok(JSON.parse(raw));
      } catch {
        return err('flowPanel.player.error.notJson');
      }
    }
    case 'code':
    case 'string':
    default: {
      if (typeof raw !== 'string') return err('flowPanel.player.error.notText');
      return ok(raw);
    }
  }
}

function validateEntitySet(raw: unknown): PlayerValidation {
  if (raw === undefined) return ok([]);
  if (typeof raw !== 'string') return err('flowPanel.player.error.notText');
  const text = raw.trim();
  if (text.length === 0) return ok([]);
  return ok(text.split(/[\n,]+/).map((s) => s.trim()).filter((s) => s.length > 0));
}

function validateTableField(raw: unknown): PlayerValidation {
  if (typeof raw !== 'string' || raw.trim().length === 0) return err('flowPanel.player.error.enterTable');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err('flowPanel.player.error.notJson');
  }
  const problems = validateTable(parsed);
  return problems.length === 0 ? ok(parsed) : err('flowPanel.player.error.notTable', { detail: problems[0].message });
}

/** Validates one raw form value against its field's declared `InputKind`. Never coerces silently. */
export function validatePlayerValue(field: PlayerField, raw: unknown): PlayerValidation {
  const kind: InputKind = field.input.kind;
  switch (kind) {
    case 'scalar':
      return validateScalar(field, raw);
    case 'enum': {
      if (typeof raw !== 'string' || raw.length === 0) return err('flowPanel.player.error.selectValue');
      if (field.options.length > 0 && !field.options.includes(raw)) return err('flowPanel.player.error.notOneOf', { options: field.options.join(', ') });
      return ok(raw);
    }
    case 'entitySet':
      return validateEntitySet(raw);
    case 'storey': {
      if (raw === undefined || raw === '') return err('flowPanel.player.error.selectStorey');
      if (typeof raw !== 'string') return err('flowPanel.player.error.selectStorey');
      return ok(raw);
    }
    case 'file': {
      if (raw === undefined || raw === '') return ok(undefined);
      if (typeof raw !== 'string') return err('flowPanel.player.error.unreadableFile');
      return ok(raw);
    }
    case 'table':
      return validateTableField(raw);
    default:
      return err('flowPanel.player.error.unknownKind', { kind: String(kind) });
  }
}

/**
 * The form's starting raw values: a persisted last-used value when there
 * is one, else the field's own default. A field with neither starts
 * blank (and, if it has no fallback default either, blocks Run until the
 * player fills it in).
 */
export function initialPlayerValues(fields: readonly PlayerField[], stored: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[field.key] = field.key in stored ? stored[field.key] : seedPlayerValue(field);
  }
  return out;
}

/**
 * Every field validated together: `undefined` values are omitted from the
 * override record so the scheduler falls back to the node's own default,
 * exactly like an absent `--input` on the CLI.
 */
export function validatePlayerValues(
  fields: readonly PlayerField[],
  raw: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly inputs: Record<string, unknown> } | { readonly ok: false; readonly errors: Record<string, TranslatableMessage> } {
  const inputs: Record<string, unknown> = {};
  const errors: Record<string, TranslatableMessage> = {};
  for (const field of fields) {
    const result = validatePlayerValue(field, raw[field.key]);
    if (!result.ok) errors[field.key] = { labelKey: result.labelKey, params: result.params };
    else if (result.value !== undefined) inputs[field.key] = result.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, inputs };
}
