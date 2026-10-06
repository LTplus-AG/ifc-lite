/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { checkAvailability, validateFlowWiring, type FlowDocument, type HostFeatures } from '@ifc-lite/flow';
import { parseCapabilities, parseCapability, hasCapability } from '@ifc-lite/extensions';
import { isModelSelector, parseTagRules } from '@ifc-lite/flow-nodes';
import { validateReportDocumentTemplate, type DocumentMappingJob, type DocumentResultMapping } from '@/lib/document/build-report-document';
import type { DocumentSpec } from '@/lib/document/types';
import { validateFileSlots } from './file-values';
import { jobsWithFiles, prepareCheck, readHistorical, historicalJobId } from './check-resources';
import type { WorkflowRun } from './run-session';
import { flowRegistry } from './runner';
import { withUpstream } from './upstream';

/** Session automation graphs run without an active model; every other graph needs one (the Flow panel's Run gate). */
export function isAutomationGraph(doc: FlowDocument): boolean {
  return doc.nodes.some((node) => /^(session\.|validation\.|comparison\.|report\.)/.test(node.type));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate every selected definition and capability before side effects. */
export async function preflightWorkflow(run: WorkflowRun, doc: FlowDocument, values: Readonly<Record<string, unknown>>, features: HostFeatures): Promise<Record<string, unknown>> {
  run.check();
  const registry = flowRegistry();
  if (isAutomationGraph(doc)) {
    const modelWrite = (capability: string) => /^model\.(create|delete|mutate)(:|$)/.test(capability);
    const scriptsCanWrite = doc.capabilities.some(modelWrite);
    const writers = doc.nodes.filter((node) => {
      if (node.type === 'session.loadModels' || node.type === 'session.assignModelTags') return false;
      const definition = registry.get(node.type);
      return definition?.writes === 'model' || definition?.capabilities.some(modelWrite)
        // Sandbox permissions come from graph grants, rather than its read-only node declaration.
        || (scriptsCanWrite && (node.type === 'script.run' || node.type === 'script.list'));
    });
    if (writers.length) throw new Error(`Session automation cannot include model-writing nodes: ${writers.map((node) => `${node.id} (${node.type})`).join(', ')}. Run model edits in a separate workflow.`);
  }
  const wiring = validateFlowWiring(doc, registry);
  if (wiring.length) throw new Error(wiring.map((p) => p.message).join('; '));
  const unavailable = checkAvailability(doc, registry, features).filter((n) => n.status === 'unknown' || n.status === 'unavailable');
  if (unavailable.length) throw new Error(unavailable.map((n) => `${n.nodeId}: ${n.reasons.join(', ')}`).join('; '));
  const grants = parseCapabilities(doc.capabilities);
  if (!grants.ok) throw new Error(grants.errors.map((e) => e.message).join('; '));
  for (const node of doc.nodes) for (const capability of registry.get(node.type)?.capabilities ?? []) {
    const parsed = parseCapability(capability);
    if (!parsed.ok || !hasCapability(grants.value, parsed.value)) throw new Error(`Workflow capability denied: ${capability}`);
  }
  const inputs = { ...values };
  let modelCount = 0, jobCount = 0;
  const slotsByAlias = new Map<string, string[]>();
  for (const input of doc.inputs) if (input.kind === 'files') {
    const key = `${input.nodeId}.${input.param}`;
    const slots = validateFileSlots(input, values[key]);
    const qualified: Record<string, readonly File[]> = {};
    for (const slot of input.fileSlots ?? []) {
      const address = `${key}/${slot.id}`;
      const files = slots[slot.id] ?? [];
      qualified[address] = files;
      if (run.files.has(address)) throw new Error(`Duplicate workflow file address: ${address}`);
      run.files.set(address, files);
      slotsByAlias.set(slot.id, [...slotsByAlias.get(slot.id) ?? [], address]);
      if (doc.nodes.find((n) => n.id === input.nodeId)?.type === 'session.loadModels') {
        if (files.some((file) => !file.name.toLowerCase().endsWith('.ifc'))) throw new Error(`Local model input requires IFC: ${slot.label}`);
        modelCount += files.length;
      }
    }
    inputs[key] = run.put('files', qualified);
  }
  for (const [alias, addresses] of slotsByAlias) {
    if (addresses.length === 1 && !run.files.has(alias)) run.files.set(alias, run.files.get(addresses[0]) ?? []);
    else if (!alias.includes('/')) run.files.delete(alias);
  }
  if (modelCount > 100) throw new Error('Choose at most 100 IFC files');
  const params = (node: FlowDocument['nodes'][number]) => ({ ...node.params,
    ...Object.fromEntries(Object.entries(inputs).filter(([key]) => key.startsWith(`${node.id}.`)).map(([key, v]) => [key.slice(node.id.length + 1), v])),
  });
  const jobsByNode = new Map<string, DocumentMappingJob[]>();
  const addJob = (nodeId: string, job: DocumentMappingJob) => jobsByNode.set(nodeId, [...jobsByNode.get(nodeId) ?? [], job]);
  for (const node of doc.nodes) {
    const p = params(node);
    if (node.type === 'session.loadModels') {
      const selectors = p.selectors === undefined ? [] : p.selectors;
      if (!Array.isArray(selectors) || selectors.length > 100 || !selectors.every(isModelSelector)) throw new Error(`Invalid loaded-model selectors for ${node.id}; choose at most 100 selectors`);
      let hasSelectedFiles = false;
      if (typeof p.files === 'string') {
        const selected = run.get<Readonly<Record<string, readonly File[]>>>(p.files, 'files');
        hasSelectedFiles = Object.values(selected).some((files) => files.length > 0);
      }
      else if (p.files === undefined || (isRecord(p.files) && Object.keys(p.files).length === 0)) {
        // A loaded-model-only graph has the native empty files default, but
        // the execution adapter still consumes an owned opaque resource.
        inputs[`${node.id}.files`] = run.put('files', {});
      } else throw new Error(`Local model files for ${node.id} must come from external file slots`);
      if (!hasSelectedFiles && selectors.length === 0) throw new Error(`Choose local IFC files or loaded-model selectors for ${node.id}`);
    }
    if (node.type === 'session.assignModelTags') parseTagRules(p.rules ?? []);
    if (node.type === 'validation.runChecks' || node.type === 'comparison.runChecks') {
      const jobs = jobsWithFiles(run, p.jobs ?? [], p.files);
      jobCount += jobs.filter((j) => j.enabled).length;
      for (const job of jobs) if (job.enabled) {
        await prepareCheck(run, job, node.type === 'validation.runChecks' ? 'validation' : 'comparison');
        addJob(node.id, { jobId: job.id, kind: node.type === 'validation.runChecks' ? 'validation' : 'comparison' });
      }
    }
    if (node.type === 'report.importComparisons') {
      for (const input of doc.inputs.filter((i) => i.nodeId === node.id && i.kind === 'files')) {
        for (const slot of input.fileSlots ?? []) {
          const address = `${input.nodeId}.${input.param}/${slot.id}`;
          for (const [index, file] of (run.files.get(address) ?? []).entries()) {
            const report = await readHistorical(run, file);
            addJob(node.id, { jobId: historicalJobId(address, index, file.name), kind: 'comparison', resultIds: [report.id] });
          }
        }
      }
    }
  }
  if (jobCount > 100) throw new Error('Enable at most 100 checks');
  for (const node of doc.nodes) if (node.type === 'report.buildDocument') {
    const config = params(node).config;
    if (config === undefined) continue;
    if (!isRecord(config)) throw new Error('Invalid report document configuration');
    if (config.mappings !== undefined && (!Array.isArray(config.mappings) || !config.mappings.every((m: unknown) => isRecord(m)
      && typeof m.blockId === 'string' && typeof m.jobId === 'string' && (m.resultId === undefined || typeof m.resultId === 'string')))) throw new Error('Invalid document result mappings');
    if (config.template !== undefined) {
      if (!isRecord(config.template)) throw new Error('Invalid native document template');
      const ancestors = withUpstream(doc, [node.id]);
      ancestors.delete(node.id);
      const documentJobs = [...ancestors].flatMap((id) => jobsByNode.get(id) ?? []);
      const errors = validateReportDocumentTemplate(config.template as unknown as DocumentSpec, (config.mappings ?? []) as DocumentResultMapping[], documentJobs);
      if (errors.length) throw new Error(errors.join('; '));
    }
  }
  run.check();
  return inputs;
}
