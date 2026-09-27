/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `{{secret:NAME}}` reference grammar (#5167 phase 3.5), recognised in
 * ONE place. It lives here, not in `@ifc-lite/flow-nodes`' `secrets.ts`,
 * because availability (`checkAvailability`, used by `flow validate` and the
 * editor) must see a graph's secret references too: a graph referencing a
 * secret the host lacks is `unavailable`, not reported runnable only to fail
 * the run's own secret preflight.
 */

import type { FlowDocument } from './document.js';

const SECRET_REF_RE = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g;

/** Walk a param value (a string, or objects/arrays holding strings such as a header map) for `{{secret:NAME}}` references. */
function collectRefs(value: unknown, out: Array<{ name: string }>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(SECRET_REF_RE)) out.push({ name: m[1] });
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
}

/** Every `(nodeId, param, secretName)` a node's params reference. */
export function referencedSecrets(doc: FlowDocument): Array<{ nodeId: string; param: string; name: string }> {
  const out: Array<{ nodeId: string; param: string; name: string }> = [];
  for (const node of doc.nodes) {
    if (!node.params) continue;
    for (const [param, value] of Object.entries(node.params)) {
      const refs: Array<{ name: string }> = [];
      collectRefs(value, refs);
      for (const r of refs) out.push({ nodeId: node.id, param, name: r.name });
    }
  }
  return out;
}

/** Replace every `{{secret:NAME}}` in `text` with `replace(name, whole)`. */
export function replaceSecretRefs(text: string, replace: (name: string, whole: string) => string): string {
  return text.replace(SECRET_REF_RE, (whole, name: string) => replace(name, whole));
}
