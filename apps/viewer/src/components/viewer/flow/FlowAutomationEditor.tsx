/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FlowDocument } from '@ifc-lite/flow';
import { parseCheckJobs } from '@ifc-lite/flow-nodes';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { setParam } from '@/lib/flow/editor-ops';
import { FilenameRulesEditor } from './automation/FilenameRulesEditor';
import { CheckJobsEditor } from './automation/CheckJobsEditor';
import { DocumentMappingEditor } from './automation/DocumentMappingEditor';

export function FlowAutomationEditor({ doc, onChange, nodeId, selectedFilenames = [] }: { doc: FlowDocument; onChange: (doc: FlowDocument) => void; nodeId?: string; selectedFilenames?: readonly string[] }) {
  const { t } = useTranslation();
  const models = useViewerStore((state) => state.models);
  const filenames = [...new Set([...selectedFilenames, ...[...models.values()].map((model) => model.sourceFile?.name ?? model.name)])];
  const slots = doc.inputs.flatMap((input) => input.fileSlots?.map((slot) => `${input.nodeId}.${input.param}/${slot.id}`) ?? []);
  const jobIds = doc.nodes.flatMap((node) => {
    if (node.type !== 'validation.runChecks' && node.type !== 'comparison.runChecks') return [];
    try { return parseCheckJobs(node.params?.jobs ?? []).filter((job) => job.enabled).map((job) => job.id); }
    catch (error) { console.warn('[flow] incomplete job configuration', error); return []; }
  });
  return <div className="space-y-3" data-flow-automation-editor>
    {doc.nodes.filter((node) => nodeId === undefined || node.id === nodeId).map((node) => {
      const change = (parameter: string, value: unknown) => onChange(setParam(doc, node.id, parameter, value));
      let form;
      if (node.type === 'session.assignModelTags') form = <FilenameRulesEditor filenames={filenames} value={node.params?.rules} onChange={(value) => change('rules', value)} />;
      else if (node.type === 'validation.runChecks' || node.type === 'comparison.runChecks') form = <CheckJobsEditor scopeKey={`${doc.id}:${node.id}`} value={node.params?.jobs} slots={slots}
        kind={node.type === 'validation.runChecks' ? 'validation' : 'comparison'} onChange={(value) => change('jobs', value)} />;
      else if (node.type === 'report.buildDocument') form = <DocumentMappingEditor scopeKey={`${doc.id}:${node.id}`} value={node.params?.config} jobIds={jobIds} onChange={(value) => change('config', value)} />;
      else return null;
      return <details key={node.id} open className="rounded border border-border p-2">
        <summary>{node.label ?? node.id} — {t('automationEditor.configuration')}</summary>{form}
      </details>;
    })}
  </div>;
}
