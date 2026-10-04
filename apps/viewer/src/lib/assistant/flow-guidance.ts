/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { flowRegistry } from '../flow/runner';
import { useViewerStore } from '@/store';

/** Native declarations only; no copied node catalog and no node run functions. */
export function flowPatchGuidance(): string {
  const registry = flowRegistry();
  const selected = new Set(useViewerStore.getState().flowDoc?.nodes.map(node => node.type));
  const definitions = registry.list();
  const contracts: unknown[] = [];
  let bytes = 0;
  for (const def of [...definitions.filter(d => selected.has(d.type)), ...definitions.filter(d => !selected.has(d.type))]) {
    const contract = { type: def.type, params: def.params.map(p => ({ name: p.name, kind: p.kind, options: p.options })),
      inputs: def.inputs.map(p => ({ name: p.name, type: p.type, optional: p.optional })),
      outputs: def.outputs.map(p => ({ name: p.name, type: p.type })), capabilities: def.capabilities, tracked: def.tracked };
    const size = JSON.stringify(contract).length;
    if (bytes + size > 24_000) continue;
    contracts.push(contract); bytes += size;
  }
  return `If the user asks to draft Flow changes, return only a complete JSON object:
{"version":1,"kind":"flow.patch","operations":[...]}
Operations: addNode {alias,type,pos:[x,y]}; removeNode {node}; moveNode {node,pos}; setParam {node,param,value}; unsetParam {node,param}; updateNode {node,patch:{label?,lacing?,tracking?,trackingKey?}}; connect {from:[node,port],to:[node,port]}; disconnect {to:[node,port]}; rename {name}. Each operation also has its exact op name as "op". Do not add other fields. Maximum 50 operations. New node aliases cannot shadow existing IDs and later operations reference the aliases. No graph or model is executed by this draft. Review will validate native types, parameters, wiring, capabilities and stale state. The frozen evidence omits existing parameter values: preserve them unless the user explicitly supplies a correction. Never invent a node or parameter contract; contracts not included below require clarification, not guessing. Tracking changes or deletion may affect element ownership on a future Run. Grants needed by new nodes will appear in the review before applying.
Available native types: ${definitions.map(d => d.type).join(', ')}
Native contracts (${contracts.length} of ${definitions.length}; omitted contracts are unavailable for this draft): ${JSON.stringify(contracts)}`;
}
