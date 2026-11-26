/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Maps IfcOpenShell findings and ours onto one key space: `rule` plus the instance it is about. */

import type { ValidationFinding } from '../src/index.js';

export interface OracleFinding {
  type: string | null;
  instance: number | null;
  instanceText?: string | null;
  attribute: string | null;
  message: string;
}

export interface Keyed {
  rule: string;
  instance?: number;
}

const last = (attribute: string | null | undefined) => (attribute ?? '').split('.').pop()!.toLowerCase();

export function oracleKey(f: OracleFinding): Keyed {
  const instance = f.instance ?? undefined;
  const msg = f.message;
  switch (f.type) {
    case 'entity_rule':
    case 'simpletype_rule':
      return { rule: (f.attribute ?? '?').toLowerCase(), instance };
    case 'global_rule':
      return { rule: `global:${(f.attribute ?? '?').toLowerCase()}` };
  }
  if (msg.startsWith('Attribute not optional')) return { rule: `not-optional:${last(f.attribute)}`, instance };
  if (msg.startsWith('Attribute is derived in subtype')) return { rule: `derived-in-subtype:${last(f.attribute)}`, instance };
  if (/^Entity \w+ is abstract/.test(msg)) return { rule: 'abstract', instance };
  if (msg.startsWith('With inverse:')) return { rule: `inverse-cardinality:${last(f.attribute)}`, instance };
  if (msg.startsWith('With attribute:') || msg.startsWith('Invalid attribute value')) return { rule: `invalid-type:${last(f.attribute)}`, instance };
  const unique = /Rule (Ifc\w+\.UR\d+)/.exec(msg);
  if (unique) return { rule: `unique:${unique[1].toLowerCase()}`, instance: instance ?? idFromOnInstance(msg) };
  if (msg.includes('IfcGloballyUniqueId base64')) return { rule: 'guid-format', instance: instance ?? idFromOnInstance(msg) };
  if (/^An enumeration literal '.*' is not valid for type/.test(msg)) return { rule: 'invalid-type:?', instance };
  if (/^Expected \d+ attribute values, found \d+/.test(msg)) return { rule: 'attribute-count', instance };
  const header = /For instance:\s+(FILE_\w+)\([\s\S]*Attribute '(\w+)' has invalid type/.exec(msg);
  if (header) return { rule: `header:${header[1].toLowerCase()}.${header[2].toLowerCase()}` };
  return { rule: `schema-other:${msg.split('\n')[0].slice(0, 80).toLowerCase()}`, instance };
}

function idFromOnInstance(msg: string): number | undefined {
  const m = /On instance:\s+#(\d+)=/.exec(msg);
  return m ? Number(m[1]) : undefined;
}

export function ourKey(f: ValidationFinding): Keyed {
  const instance = f.instance;
  switch (f.category) {
    case 'entity_rule':
    case 'simpletype_rule':
      return { rule: f.rule.toLowerCase(), instance };
    case 'global_rule':
      return { rule: `global:${f.rule.split('.')[0].toLowerCase()}` };
    case 'unique_rule':
      return { rule: `unique:${f.rule.toLowerCase()}`, instance };
    case 'header':
      return { rule: `header:${f.rule.toLowerCase()}` };
    case 'evaluation_error':
      return { rule: f.rule.toLowerCase(), instance };
    case 'schema':
      switch (f.rule) {
        case 'not-optional': case 'derived-in-subtype': case 'invalid-type': case 'inverse-cardinality':
          return { rule: `${f.rule}:${last(f.attribute)}`, instance };
        case 'invalid-derived-marker':
          return { rule: `invalid-type:${last(f.attribute)}`, instance };
        default:
          return { rule: f.rule, instance };
      }
  }
}

export const keyString = (k: Keyed) => `${k.rule}|${k.instance ?? ''}`;

/** Does a finding key (`rule|instance`) hit a corpus target such as `IfcWall.CorrectPredefinedType` or `not-optional`? */
export function hitsTarget(key: string, target: string): boolean {
  const rule = key.split('|')[0];
  const t = target.toLowerCase();
  return rule === t || rule.startsWith(`${t}:`) || rule.endsWith(`:${t}`);
}

/** The rule family a key belongs to, for per-rule tables (`not-optional:globalid` -> `not-optional`). */
export function ruleFamily(rule: string): string {
  const colon = rule.indexOf(':');
  if (colon < 0) return rule;
  const head = rule.slice(0, colon);
  return ['global', 'unique', 'header', 'evaluation-error'].includes(head) ? rule : head;
}
