/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { resolveParams, type FlowDocument } from '@ifc-lite/flow';
import type { FlowHost } from '@ifc-lite/flow-nodes';
import type { NodeRegistry } from '@ifc-lite/flow';
/** Explicit native node effect contracts. New node kinds fail closed until their task effects are reviewed here. */
const KNOWN_NATIVE_NODES = new Set([
  'ai.classify', 'ai.extract', 'ai.propose', 'ai.summarize',
  'aps.modelProperties', 'aps.token', 'bcf.addComment', 'bcf.createTopic', 'bcf.listTopics', 'comparison.runChecks',
  'core.boolean', 'core.compare', 'core.concat', 'core.count', 'core.filter', 'core.first',
  'core.flatten', 'core.groupBy', 'core.item', 'core.keys', 'core.list', 'core.lookup',
  'core.math', 'core.number', 'core.string', 'core.sum', 'core.wrap', 'documents.download',
  'documents.queryVersions', 'element.beam', 'element.column', 'element.railing', 'element.slab', 'element.stair',
  'element.wall', 'geometry.point', 'http.request', 'ids.lint', 'ids.load', 'ids.validate',
  'model.addElement', 'model.applyTable', 'model.attribute', 'model.byType', 'model.contains', 'model.delete',
  'model.groupByStorey', 'model.groupByType', 'model.openFromSource', 'model.property', 'model.quantity', 'model.related',
  'model.select', 'model.setAttribute', 'model.setProperty', 'model.storey', 'report.buildDocument', 'report.exportPdf',
  'report.importComparisons', 'review.snapshot', 'script.list', 'script.run', 'session.assignModelTags', 'session.loadModels',
  'speckle.receive', 'table.column', 'table.fromEntities', 'table.groupRows', 'table.joinByKey', 'table.longFormat',
  'table.pivot', 'table.readCsv', 'table.readXlsx', 'table.rowCount', 'table.writeCsv', 'table.writeXlsx',
  'validation.runChecks', 'viewer.colorize', 'viewer.flyTo', 'viewer.isolate', 'viewer.select', 'viewer.selection',
]);
const NATIVE_REMOTE_READS = new Set(['bcf.listTopics', 'aps.token', 'aps.modelProperties', 'documents.queryVersions', 'documents.download', 'model.openFromSource', 'speckle.receive']);
export function admitAgentFlowEffects(doc: FlowDocument, registry: NodeRegistry<FlowHost>, inputs: Readonly<Record<string, unknown>>) {
  const unknown: string[] = [], publication: string[] = [];
  for (const node of doc.nodes) {
    const definition = registry.get(node.type);
    if (!definition || !KNOWN_NATIVE_NODES.has(node.type)) { unknown.push(node.id); continue; }
    // Canonical defaults and declared Player parameters are the only inputs that may change node effects.
    const overrides: Record<string, unknown> = {};
    for (const param of definition.params) {
      const value = inputs[`${node.id}.${param.name}`]; if (value !== undefined) overrides[param.name] = value;
    }
    const params = resolveParams(definition, { ...node.params, ...overrides });
    if (node.type === 'http.request') {
      const method = typeof params.method === 'string' ? params.method.toUpperCase() : '';
      const declared = definition.params.find(param => param.name === 'method');
      if (!declared?.options?.includes(method)) { unknown.push(node.id); continue; }
      // Any agent-run request needs approval: a GET's URL can carry model data out as easily as a POST body.
      publication.push(node.id);
      continue;
    }
    if (node.type.startsWith('script.') && doc.capabilities.some(capability => capability.startsWith('network.fetch'))) { publication.push(node.id); continue; }
    // A remote-capable definition defaults to publication admission unless its native provider protocol is a known read.
    const remote = definition.requires?.network || definition.requiresForParams?.(params).network || definition.capabilities.some(capability => capability.startsWith('network.fetch'));
    if (remote && !NATIVE_REMOTE_READS.has(node.type)) publication.push(node.id);
  }
  return { admitted: unknown.length === 0 && publication.length === 0, unknown, publication };
}
