/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite schema
 *
 * Dump the complete SDK API schema as JSON.
 * Useful for LLM tools to discover available commands and methods.
 */

import { printJson, hasFlag } from '../output.js';

export async function schemaCommand(args: string[]): Promise<void> {
  const compact = hasFlag(args, '--compact');

  // Dynamically import the bridge schema to get tool definitions
  let schemas: any[];
  try {
    const mod = await import('@ifc-lite/sandbox/schema');
    schemas = mod.NAMESPACE_SCHEMAS;
  } catch (err) {
    // Fallback: a small hand-maintained subset of the real schema. Callers
    // of `ifc-lite schema` are usually LLM tools discovering the API — being
    // handed a truncated namespace list that looks authoritative is worse
    // than being told the load failed, so say so on stderr (stdout stays
    // pure JSON).
    process.stderr.write(
      `Warning: could not load the full SDK schema from @ifc-lite/sandbox/schema ` +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        `emitting a reduced built-in schema that omits namespaces and methods.\n`,
    );
    schemas = getStaticSchema();
    // stderr is the one channel a `schema | jq` pipeline routinely discards;
    // a non-zero exit is the signal such a caller can't ignore without
    // opting out of error handling altogether. stdout stays pure JSON.
    process.exitCode = 1;
  }

  const output = schemas.map(ns => ({
    namespace: ns.name,
    description: ns.doc,
    methods: ns.methods.map((m: any) => {
      const entry: Record<string, unknown> = {
        name: m.name,
        description: m.doc,
      };
      if (!compact) {
        if (m.paramNames) entry.params = m.paramNames;
        if (m.tsReturn) entry.returns = m.tsReturn;
        if (m.llmSemantics?.useWhen) entry.useWhen = m.llmSemantics.useWhen;
        if (m.llmSemantics?.taskTags) entry.taskTags = m.llmSemantics.taskTags;
      }
      return entry;
    }),
  }));

  printJson(output);
}

function getStaticSchema(): any[] {
  return [
    {
      name: 'model', doc: 'Model operations',
      methods: [
        { name: 'list', doc: 'List loaded models' },
        { name: 'active', doc: 'Get active model' },
        { name: 'activeId', doc: 'Get active model ID' },
      ],
    },
    {
      name: 'query', doc: 'Query entities',
      methods: [
        { name: 'all', doc: 'Get all entities' },
        { name: 'byType', doc: 'Filter by IFC type', paramNames: ['...types'] },
        { name: 'entity', doc: 'Get single entity', paramNames: ['modelId', 'expressId'] },
        { name: 'attributes', doc: 'Entity IFC attributes', paramNames: ['entity'] },
        { name: 'properties', doc: 'Property sets', paramNames: ['entity'] },
        { name: 'quantities', doc: 'Quantity sets', paramNames: ['entity'] },
        { name: 'classifications', doc: 'Classification references', paramNames: ['entity'] },
        { name: 'materials', doc: 'Material assignments', paramNames: ['entity'] },
        { name: 'typeProperties', doc: 'Type-level properties', paramNames: ['entity'] },
        { name: 'documents', doc: 'Linked documents', paramNames: ['entity'] },
        { name: 'relationships', doc: 'Structural relationships', paramNames: ['entity'] },
      ],
    },
    {
      name: 'export', doc: 'Multi-format export',
      methods: [
        { name: 'csv', doc: 'Export to CSV', paramNames: ['entities', 'options'] },
        { name: 'json', doc: 'Export to JSON', paramNames: ['entities', 'columns'] },
        { name: 'ifc', doc: 'Export to IFC STEP', paramNames: ['entities', 'options'] },
      ],
    },
    {
      name: 'ids', doc: 'IDS validation',
      methods: [
        { name: 'parse', doc: 'Parse IDS XML document', paramNames: ['xmlContent'] },
        { name: 'validate', doc: 'Validate against IFC model', paramNames: ['idsDocument', 'options'] },
        { name: 'summarize', doc: 'Summarize validation report', paramNames: ['report'] },
      ],
    },
    {
      name: 'bcf', doc: 'BCF collaboration',
      methods: [
        { name: 'createProject', doc: 'Create BCF project', paramNames: ['options'] },
        { name: 'createTopic', doc: 'Create topic/issue', paramNames: ['options'] },
        { name: 'createComment', doc: 'Create comment', paramNames: ['options'] },
        { name: 'read', doc: 'Read BCF file', paramNames: ['data'] },
        { name: 'write', doc: 'Write BCF file', paramNames: ['project'] },
      ],
    },
    {
      name: 'create', doc: 'IFC creation',
      methods: [
        { name: 'project', doc: 'Create new IFC project', paramNames: ['params'] },
        { name: 'building', doc: 'Create project with one storey', paramNames: ['params'] },
      ],
    },
  ];
}
