/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.structural namespace methods.
 *
 * Reads IFC structural analysis data (IfcStructuralAnalysisModel,
 * IfcStructuralMember / IfcStructuralConnection / IfcStructuralActivity
 * subtypes, IfcStructuralLoadGroup / IfcStructuralLoadCase,
 * IfcStructuralResultGroup) from the active model. Reuses the `query`
 * permission, same as `bim.schedule` and `bim.query.*` — this is read-only
 * metadata access.
 *
 * Follows `bridge-schedule.ts`'s pattern exactly: a field-spec table per
 * struct is the single source of truth for the emitted TypeScript return
 * type AND the camelCase → IFC-PascalCase runtime translator. The two
 * nested leaf structs — a load (`IfcStructuralLoadOrResult`) and a boundary
 * condition (`IfcBoundaryCondition`) — carry a `components` record keyed by
 * arbitrary EXPRESS attribute names rather than a fixed field list, so their
 * translators pass that record through unchanged under `Components` instead
 * of being schema-driven like the six main structs.
 */

import type { NamespaceSchema } from './bridge-schema.js';

// ─── Schema: one source of truth for field mapping + TS types ─────────

interface FieldSpec {
  pascalKey: string;
  camelKey: string;
  tsType: string;
  optional: boolean;
}

function mk(pascal: string, camel: string, tsType: string, optional = true): FieldSpec {
  return { pascalKey: pascal, camelKey: camel, tsType, optional };
}

const ANALYSIS_MODEL_FIELDS: FieldSpec[] = [
  mk('GlobalId',              'globalId',              'string', false),
  mk('ExpressId',             'expressId',             'number', false),
  mk('Name',                  'name',                  'string'),
  mk('Description',           'description',           'string'),
  mk('ObjectType',            'objectType',            'string'),
  mk('PredefinedType',        'predefinedType',        'string'),
  mk('LoadGroupGlobalIds',    'loadGroupGlobalIds',    'string[]', false),
  mk('ResultGroupGlobalIds',  'resultGroupGlobalIds',  'string[]', false),
  mk('ItemGlobalIds',         'itemGlobalIds',         'string[]', false),
];

const MEMBER_FIELDS: FieldSpec[] = [
  mk('GlobalId',               'globalId',               'string', false),
  mk('ExpressId',              'expressId',              'number', false),
  mk('Type',                   'type',                   'string', false),
  mk('Name',                   'name',                   'string'),
  mk('Description',            'description',            'string'),
  mk('ObjectType',             'objectType',             'string'),
  mk('PredefinedType',         'predefinedType',         'string'),
  mk('Thickness',              'thickness',              'number'),
  mk('ConnectionGlobalIds',    'connectionGlobalIds',    'string[]', false),
  mk('ActivityGlobalIds',      'activityGlobalIds',      'string[]', false),
  mk('AnalysisModelGlobalIds', 'analysisModelGlobalIds', 'string[]', false),
];

// AppliedCondition is a nested struct — handled by the schema-to-type helper below.
const CONNECTION_FIELDS: FieldSpec[] = [
  mk('GlobalId',               'globalId',               'string', false),
  mk('ExpressId',              'expressId',              'number', false),
  mk('Type',                   'type',                   'string', false),
  mk('Name',                   'name',                   'string'),
  mk('Description',            'description',            'string'),
  mk('ObjectType',             'objectType',             'string'),
  mk('MemberGlobalIds',        'memberGlobalIds',        'string[]', false),
  mk('ActivityGlobalIds',      'activityGlobalIds',      'string[]', false),
  mk('AnalysisModelGlobalIds', 'analysisModelGlobalIds', 'string[]', false),
];

// AppliedLoad is a nested struct — handled by the schema-to-type helper below.
const ACTIVITY_FIELDS: FieldSpec[] = [
  mk('GlobalId',           'globalId',           'string', false),
  mk('ExpressId',          'expressId',          'number', false),
  mk('Type',               'type',               'string', false),
  mk('Kind',               'kind',               "'Action' | 'Reaction' | 'Unknown'", false),
  mk('Name',               'name',               'string'),
  mk('Description',        'description',        'string'),
  mk('ObjectType',         'objectType',         'string'),
  mk('PredefinedType',     'predefinedType',     'string'),
  mk('GlobalOrLocal',      'globalOrLocal',      'string'),
  mk('DestabilizingLoad',  'destabilizingLoad',  'boolean'),
  mk('AppliesToGlobalId',  'appliesToGlobalId',  'string'),
  mk('GroupGlobalIds',     'groupGlobalIds',     'string[]', false),
];

const LOAD_GROUP_FIELDS: FieldSpec[] = [
  mk('GlobalId',               'globalId',               'string', false),
  mk('ExpressId',              'expressId',              'number', false),
  mk('Type',                   'type',                   'string', false),
  mk('Name',                   'name',                   'string'),
  mk('Description',            'description',            'string'),
  mk('ObjectType',             'objectType',             'string'),
  mk('PredefinedType',         'predefinedType',         'string'),
  mk('ActionType',             'actionType',             'string'),
  mk('ActionSource',           'actionSource',           'string'),
  mk('Coefficient',            'coefficient',            'number'),
  mk('Purpose',                'purpose',                'string'),
  mk('SelfWeightCoefficients', 'selfWeightCoefficients', 'number[]'),
  mk('ActivityGlobalIds',      'activityGlobalIds',      'string[]', false),
];

const RESULT_GROUP_FIELDS: FieldSpec[] = [
  mk('GlobalId',                    'globalId',                    'string', false),
  mk('ExpressId',                   'expressId',                   'number', false),
  mk('Name',                        'name',                        'string'),
  mk('Description',                 'description',                 'string'),
  mk('ObjectType',                  'objectType',                  'string'),
  mk('TheoryType',                  'theoryType',                  'string'),
  mk('IsLinear',                    'isLinear',                    'boolean'),
  mk('ResultForLoadGroupGlobalId',  'resultForLoadGroupGlobalId',  'string'),
  mk('ActivityGlobalIds',           'activityGlobalIds',           'string[]', false),
];

// ─── Schema → TS return-type string ────────────────────────────────────

function buildReturnType(fields: FieldSpec[], extra: string = ''): string {
  const parts = fields.map(f => `${f.pascalKey}${f.optional ? '?' : ''}: ${f.tsType}`);
  if (extra) parts.push(extra);
  return `{ ${parts.join('; ')} }`;
}

// A load's numeric/boolean components are keyed by arbitrary EXPRESS
// attribute names (ForceX, LinearForceZ, TranslationalStiffnessX, …), so
// the TS type is a dictionary rather than a fixed field list — exactly like
// `StructuralLoadData.components` / `BoundaryConditionData.components`.
const LOAD_RETURN = 'BimStructuralLoad';

/** Named ambient declarations are required to describe recursively nested configurations. */
export const STRUCTURAL_AMBIENT_DECLARATIONS = [
  'interface BimStructuralLoad {',
  '  ExpressId: number; Type: string; Name?: string;',
  '  Components: Record<string, number>;',
  '  Configuration?: BimStructuralLoadConfiguration;',
  '}',
  'interface BimStructuralLoadConfiguration {',
  "  Entries: Array<{ Value?: BimStructuralLoad; Dropped?: 'depth' | 'cycle' | 'budget' | 'invalid-reference' | 'unresolved' | 'unreadable'; Location?: number[] }>;",
  '  Locations?: number[][]; Truncated: boolean;',
  '}',
];

const BOUNDARY_CONDITION_RETURN =
  `{ ExpressId: number; Type: string; Name?: string; Components: Record<string, number | boolean> }`;

const ANALYSIS_MODEL_RETURN = buildReturnType(ANALYSIS_MODEL_FIELDS);
const MEMBER_RETURN         = buildReturnType(MEMBER_FIELDS);
const CONNECTION_RETURN     = buildReturnType(CONNECTION_FIELDS, `AppliedCondition?: ${BOUNDARY_CONDITION_RETURN}`);
const ACTIVITY_RETURN       = buildReturnType(ACTIVITY_FIELDS, `AppliedLoad?: ${LOAD_RETURN}`);
const LOAD_GROUP_RETURN     = buildReturnType(LOAD_GROUP_FIELDS);
const RESULT_GROUP_RETURN   = buildReturnType(RESULT_GROUP_FIELDS);

const DATA_RETURN =
  `{ HasStructural: boolean; LoadsTruncated: boolean;`
  + ` AnalysisModels: Array<${ANALYSIS_MODEL_RETURN}>;`
  + ` Members: Array<${MEMBER_RETURN}>;`
  + ` Connections: Array<${CONNECTION_RETURN}>;`
  + ` Activities: Array<${ACTIVITY_RETURN}>;`
  + ` LoadGroups: Array<${LOAD_GROUP_RETURN}>;`
  + ` ResultGroups: Array<${RESULT_GROUP_RETURN}> }`;

// ─── Schema → runtime translator ──────────────────────────────────────

function translateByFields(source: Record<string, unknown>, fields: FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.pascalKey] = source[f.camelKey];
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateLoad(l: any): Record<string, unknown> | undefined {
  if (!l) return undefined;
  return {
    ExpressId: l.expressId,
    Type: l.type,
    Name: l.name,
    Components: l.components,
    Configuration: translateConfiguration(l.configuration),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateConfiguration(c: any): Record<string, unknown> | undefined {
  if (!c) return undefined;
  return {
    // `truncated` propagates unconditionally here: a caller reading one
    // activity's applied load must see this exactly like `data().LoadsTruncated`
    // sees it at the extraction level — dropping it here would report a
    // partial load tree as complete one layer above where #4510 fixed it.
    Truncated: c.truncated,
    Locations: c.locations,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Entries: (c.entries ?? []).map((e: any) => ({
      Value: translateLoad(e.value),
      Dropped: e.dropped,
      Location: e.location,
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateBoundaryCondition(b: any): Record<string, unknown> | undefined {
  if (!b) return undefined;
  return { ExpressId: b.expressId, Type: b.type, Name: b.name, Components: b.components };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateAnalysisModel(m: any): Record<string, unknown> {
  return translateByFields(m, ANALYSIS_MODEL_FIELDS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateMember(m: any): Record<string, unknown> {
  return translateByFields(m, MEMBER_FIELDS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateConnection(c: any): Record<string, unknown> {
  return { ...translateByFields(c, CONNECTION_FIELDS), AppliedCondition: translateBoundaryCondition(c.appliedCondition) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateActivity(a: any): Record<string, unknown> {
  return { ...translateByFields(a, ACTIVITY_FIELDS), AppliedLoad: translateLoad(a.appliedLoad) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateLoadGroup(g: any): Record<string, unknown> {
  return translateByFields(g, LOAD_GROUP_FIELDS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateResultGroup(g: any): Record<string, unknown> {
  return translateByFields(g, RESULT_GROUP_FIELDS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateData(d: any): Record<string, unknown> {
  return {
    HasStructural: d.hasStructural,
    // Forwarded straight off the extraction, unconditionally — see
    // `translateConfiguration` above for why this can never be hardcoded.
    LoadsTruncated: d.loadsTruncated,
    AnalysisModels: (d.analysisModels ?? []).map(translateAnalysisModel),
    Members: (d.members ?? []).map(translateMember),
    Connections: (d.connections ?? []).map(translateConnection),
    Activities: (d.activities ?? []).map(translateActivity),
    LoadGroups: (d.loadGroups ?? []).map(translateLoadGroup),
    ResultGroups: (d.resultGroups ?? []).map(translateResultGroup),
  };
}

// Exposed for tests — lets us assert TS return shape stays byte-identical
// when we refactor the schema-to-type builder.
export const __structural_schema_testing = {
  ANALYSIS_MODEL_FIELDS,
  MEMBER_FIELDS,
  CONNECTION_FIELDS,
  ACTIVITY_FIELDS,
  LOAD_GROUP_FIELDS,
  RESULT_GROUP_FIELDS,
  ANALYSIS_MODEL_RETURN,
  MEMBER_RETURN,
  CONNECTION_RETURN,
  ACTIVITY_RETURN,
  LOAD_GROUP_RETURN,
  RESULT_GROUP_RETURN,
  DATA_RETURN,
  translateAnalysisModel,
  translateMember,
  translateConnection,
  translateActivity,
  translateLoadGroup,
  translateResultGroup,
  translateLoad,
  translateConfiguration,
  translateBoundaryCondition,
  translateData,
};

export function buildStructuralNamespace(): NamespaceSchema {
  return {
    name: 'structural',
    doc: 'Structural analysis reader (IfcStructuralAnalysisModel, members, connections, activities, load/result groups)',
    ambientDeclarations: STRUCTURAL_AMBIENT_DECLARATIONS,
    permission: 'query',
    methods: [
      {
        name: 'data',
        doc: 'Full structural extraction — analysis models, members, connections, activities, load groups, result groups.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: DATA_RETURN,
        call: (sdk, args) => translateData(sdk.structural.data(args[0] as string | undefined)),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Inspect the full structural analysis graph — members, connections, applied loads and computed reactions. Check LoadsTruncated before reporting a load count as complete. Omit modelId to read the active model.',
        },
      },
      {
        name: 'analysisModels',
        doc: 'All IfcStructuralAnalysisModel containers.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${ANALYSIS_MODEL_RETURN}>`,
        call: (sdk, args) => (sdk.structural.analysisModels(args[0] as string | undefined) ?? []).map(translateAnalysisModel),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List the analysis models in the file and which load/result groups belong to each.',
        },
      },
      {
        name: 'members',
        doc: 'All IfcStructuralMember subtype occurrences (curve, surface).',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${MEMBER_RETURN}>`,
        call: (sdk, args) => (sdk.structural.members(args[0] as string | undefined) ?? []).map(translateMember),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List structural members and the connections/activities each one is joined to.',
        },
      },
      {
        name: 'connections',
        doc: 'All IfcStructuralConnection subtype occurrences, with resolved support conditions.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${CONNECTION_RETURN}>`,
        call: (sdk, args) => (sdk.structural.connections(args[0] as string | undefined) ?? []).map(translateConnection),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List structural connections and inspect their boundary/support conditions.',
        },
      },
      {
        name: 'activities',
        doc: 'All IfcStructuralActivity subtype occurrences — applied actions and computed reactions.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${ACTIVITY_RETURN}>`,
        call: (sdk, args) => (sdk.structural.activities(args[0] as string | undefined) ?? []).map(translateActivity),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'Inspect applied loads (Kind = Action) and computed reactions (Kind = Reaction) separately.',
        },
      },
      {
        name: 'loadGroups',
        doc: 'All IfcStructuralLoadGroup / IfcStructuralLoadCase entities.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${LOAD_GROUP_RETURN}>`,
        call: (sdk, args) => (sdk.structural.loadGroups(args[0] as string | undefined) ?? []).map(translateLoadGroup),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List load cases / load groups and the actions assigned into each.',
        },
      },
      {
        name: 'resultGroups',
        doc: 'All IfcStructuralResultGroup entities.',
        args: ['string'],
        paramNames: ['modelId'],
        tsParamTypes: ['string | undefined'],
        tsReturn: `Array<${RESULT_GROUP_RETURN}>`,
        call: (sdk, args) => (sdk.structural.resultGroups(args[0] as string | undefined) ?? []).map(translateResultGroup),
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect'],
          useWhen: 'List result groups and which load case each one solved.',
        },
      },
    ],
  };
}
