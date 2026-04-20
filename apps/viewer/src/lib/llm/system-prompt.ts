/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * System prompt builder for LLM chat.
 *
 * Auto-generates the API reference from the same NAMESPACE_SCHEMAS
 * that power CodeMirror autocomplete and the QuickJS bridge.
 * This ensures the LLM always has an accurate, up-to-date API surface.
 */

import {
  NAMESPACE_SCHEMAS,
  type LlmTaskIntent,
  type MethodPlacementKind,
  type MethodSchema,
} from '@ifc-lite/sandbox/schema';
import type { FileAttachment } from './types.js';
import type { ScriptEditorSelection } from './types.js';
import { formatDiagnosticsForPrompt, type ScriptDiagnostic } from './script-diagnostics.js';

const MAX_ATTACHMENT_ROWS_IN_PROMPT = 5;
const MAX_ATTACHMENT_TEXT_PREVIEW_CHARS = 1200;

/** Context about the currently loaded IFC model */
export interface ModelContext {
  models: Array<{ name: string; entityCount: number }>;
  typeCounts: Record<string, number>;
  selectedCount: number;
  storeys?: Array<{ modelName?: string; name: string; elevation: number; height?: number; elementCount?: number }>;
  selectedEntities?: Array<{
    modelName?: string;
    name: string;
    type: string;
    selectionKind?: 'occurrence' | 'type';
    globalId?: string;
    storeyName?: string;
    storeyElevation?: number;
    propertySets?: string[];
    typePropertySets?: string[];
    quantitySets?: string[];
    materialName?: string;
    classifications?: string[];
  }>;
}

export interface ScriptEditorPromptContext {
  content: string;
  revision: number;
  selection: ScriptEditorSelection;
}

export interface PromptTaskContext {
  userPrompt?: string;
  diagnostics?: ScriptDiagnostic[];
}

interface NamespacedMethod {
  namespace: string;
  method: MethodSchema;
}

function getAllNamespacedMethods(): NamespacedMethod[] {
  return NAMESPACE_SCHEMAS.flatMap((namespace) => namespace.methods.map((method) => ({
    namespace: namespace.name,
    method,
  })));
}

function inferPromptIntent(task?: PromptTaskContext): LlmTaskIntent {
  if (task?.diagnostics && task.diagnostics.length > 0) return 'repair';

  const text = task?.userPrompt?.toLowerCase() ?? '';
  if (!text) return 'create';
  if (/\bfix|error|failed|repair|debug|why\b/.test(text)) return 'repair';
  if (/\bcolor|hide|show|isolate|highlight|visuali[sz]e|fly to\b/.test(text)) return 'visualize';
  if (/\bquery|inspect|analy[sz]e|material|classification|property|quantity|metadata|what is|list\b/.test(text)) return 'inspect';
  if (/\bmodify|update|change|edit|rename|delete|set property\b/.test(text)) return 'modify';
  if (/\bexport|csv|json|download\b/.test(text)) return 'export';
  return 'create';
}

function formatKeys(keys: string[]): string {
  return keys.map((key) => `\`${key}\``).join(', ');
}

function buildIntentMethodSection(intent: LlmTaskIntent): string {
  const matches = getAllNamespacedMethods()
    .filter(({ method }) => method.llmSemantics?.taskTags?.includes(intent))
    .slice(0, 12);

  if (matches.length === 0) return '';

  const lines = ['## CURRENT TASK FOCUS', `- Primary intent: \`${intent}\``];
  for (const { namespace, method } of matches) {
    const synopsis = method.llmSemantics?.useWhen ?? method.doc;
    lines.push(`- \`bim.${namespace}.${method.name}(...)\`: ${synopsis}`);
  }
  return lines.join('\n');
}

function buildCreateContractCheatSheet(): string {
  const createNamespace = NAMESPACE_SCHEMAS.find((schema) => schema.name === 'create');
  if (!createNamespace) return '## BIM.CREATE CONTRACT CHEAT SHEET';

  const lines = ['## BIM.CREATE CONTRACT CHEAT SHEET'];
  for (const method of createNamespace.methods) {
    const semantics = method.llmSemantics;
    if (!semantics?.requiredKeys?.length && !semantics?.anyOfKeys?.length) continue;

    const clauses: string[] = [];
    if (semantics.requiredKeys?.length) {
      clauses.push(`use ${formatKeys(semantics.requiredKeys)}`);
    }
    if (semantics.anyOfKeys?.length) {
      clauses.push(`plus one of ${semantics.anyOfKeys.map((group) => group.map((key) => `\`${key}\``).join(' + ')).join(' OR ')}`);
    }
    if (semantics.useWhen) {
      clauses.push(semantics.useWhen);
    }
    if (semantics.cautions?.length) {
      clauses.push(semantics.cautions.join(' '));
    }
    if (method.name === 'addIfcRoof') {
      clauses.push('Do NOT use `Profile`, `Height`, or `ExtrusionHeight` with `addIfcRoof`.');
    }
    if (method.name === 'addIfcSlab') {
      clauses.push('Here `Profile` means a 2D point array, not a generic IFC profile object.');
    }
    if (method.name === 'addIfcWallDoor' || method.name === 'addIfcWallWindow') {
      clauses.push('Use wall-local `Position` relative to the host wall, typically `[alongWall, 0, baseOrSillHeight]`.');
    }
    lines.push(`- \`${method.name}\`: ${clauses.join('. ')}`);
  }

  lines.push('- Wall-hosted openings: use `Openings` inside `addIfcWall(...)` when you only need a void.');
  lines.push('- If the user asks for a house roof, pitched roof, or gable roof, default to `addIfcGableRoof`.');
  lines.push('- `addIfcDoor` and `addIfcWindow`: these create standalone world-aligned elements.');
  lines.push('- `addElement`: Use `IfcType`, `Placement: { Location: [...] }`, `Profile`, and `Depth`. Use `IfcType` not `Type`; use `Placement` not `Position`.');
  return lines.join('\n');
}

function buildPlacementSemanticsSection(): string {
  const createNamespace = NAMESPACE_SCHEMAS.find((schema) => schema.name === 'create');
  if (!createNamespace) return '## PLACEMENT SEMANTICS';

  const groups = new Map<MethodPlacementKind, string[]>();
  for (const method of createNamespace.methods) {
    const placement = method.llmSemantics?.placement;
    if (!placement) continue;
    groups.set(placement, [...(groups.get(placement) ?? []), method.name]);
  }

  const formatGroup = (placement: MethodPlacementKind, label: string) => {
    const methods = groups.get(placement) ?? [];
    return methods.length > 0 ? `- ${label}: ${methods.map((name) => `\`${name}\``).join(', ')}.` : null;
  };

  return [
    '## PLACEMENT SEMANTICS',
    formatGroup('storey-relative', 'Common storey-relative methods'),
    formatGroup('wall-local', 'Hosted wall insert methods'),
    formatGroup('world', 'Many advanced methods are world-placement based'),
    formatGroup('explicit-placement', 'Explicit-placement generic methods'),
    '- For world-placement methods, do NOT assume the storey elevation is automatically applied.',
    '- Mixed multi-level scripts often combine both: storey-relative and world-placement helpers.',
    '- If repeated world-placement elements are generated inside a storey loop, those calls should usually use `elevation` or `z` in their `Start`/`End`/`Position` Z coordinates.',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function buildInspectionGuidance(): string {
  const preferredOrder = [
    'query.selection',
    'query.storeys',
    'query.path',
    'query.storey',
    'query.attributes',
    'query.properties',
    'query.property',
    'query.quantities',
    'query.materials',
    'query.classifications',
    'query.documents',
    'query.typeProperties',
    'query.relationships',
    'query.related',
  ];

  const lookup = new Map<string, string>();
  for (const { namespace, method } of getAllNamespacedMethods().filter(({ method }) => method.llmSemantics?.inspectFirst)) {
    let args = '';
    if (['path', 'storey', 'attributes', 'properties', 'property', 'quantities', 'materials', 'classifications', 'documents', 'typeProperties', 'relationships'].includes(method.name)) {
      args = 'entity';
    } else if (method.name === 'related') {
      args = 'entity, relType, direction';
    }
    lookup.set(`${namespace}.${method.name}`, `\`bim.${namespace}.${method.name}(${args})\``);
  }

  const methods = preferredOrder
    .map((key) => lookup.get(key))
    .filter((value): value is string => Boolean(value));
  return methods.join(', ');
}

/** Map ArgType → TypeScript type string for prompt */
function argTypeToTS(argType: string, tsOverride?: string): string {
  if (tsOverride) return tsOverride;
  switch (argType) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'dump': return 'object';
    case 'entityRefs': return 'BimEntity[]';
    case '...strings': return '...string[]';
    default: return 'unknown';
  }
}

/** Map ReturnType → TypeScript type string */
function returnTypeToTS(returnType: string, tsOverride?: string): string {
  if (tsOverride) return tsOverride;
  switch (returnType) {
    case 'void': return 'void';
    case 'string': return 'string';
    case 'value': return 'unknown';
    default: return 'unknown';
  }
}

/** Generate the full API reference from NAMESPACE_SCHEMAS */
function buildApiReference(): string {
  const sections: string[] = [];

  for (const ns of NAMESPACE_SCHEMAS) {
    const lines: string[] = [`### bim.${ns.name} — ${ns.doc}`];

    for (const method of ns.methods) {
      const params = method.args.map((argType, i) => {
        const name = method.paramNames?.[i] ?? `arg${i}`;
        const tsType = argTypeToTS(argType, method.tsParamTypes?.[i]);
        return `${name}: ${tsType}`;
      }).join(', ');

      const ret = returnTypeToTS(method.returns, method.tsReturn);
      lines.push(`- \`bim.${ns.name}.${method.name}(${params})\` → \`${ret}\``);
      lines.push(`  ${method.doc}`);
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n');
}

function listNamespaces(): string {
  return NAMESPACE_SCHEMAS.map((ns) => ns.name).join(', ');
}

// Cache the API reference — it never changes at runtime
let _cachedApiRef: string | null = null;
function getApiReference(): string {
  if (!_cachedApiRef) {
    _cachedApiRef = buildApiReference();
  }
  return _cachedApiRef;
}

/**
 * Build the complete system prompt for the LLM.
 */
export function buildSystemPrompt(
  modelContext?: ModelContext,
  attachments?: FileAttachment[],
  scriptEditor?: ScriptEditorPromptContext,
  task?: PromptTaskContext,
): string {
  const apiRef = getApiReference();
  const namespaces = listNamespaces();
  const intent = inferPromptIntent(task);
  const intentSection = buildIntentMethodSection(intent);
  const createContractCheatSheet = buildCreateContractCheatSheet();
  const placementSemantics = buildPlacementSemanticsSection();
  const inspectionGuidance = buildInspectionGuidance();

  let prompt = `You are an IFC/BIM scripting assistant embedded in ifc-lite, a web-based IFC viewer with a live 3D viewport.
You write JavaScript code that executes in a sandboxed environment with a global \`bim\` object.

## YOUR CAPABILITIES
- Create complete IFC buildings from scratch (walls, slabs, columns, beams, stairs, roofs)
- Query and analyze loaded IFC models
- Colorize, hide, show, isolate, and fly to entities in the 3D viewer
- Modify properties on existing entities
- Export data as IFC, CSV or JSON
- Process uploaded CSV/JSON files and apply data to IFC models

${intentSection}

## CRITICAL RULES
0. For script modifications, prefer exact SEARCH/REPLACE edits using this fenced format:
   \`\`\`ifc-script-edits
   <<<<<<< SEARCH
   exact current code from the script editor
   =======
   replacement code
   >>>>>>> REPLACE
   \`\`\`
   - Copy every SEARCH block exactly from the CURRENT script before any of your replacements. Do not invent offsets or line numbers.
   - Each SEARCH block must match exactly one location in the CURRENT script. If the target text is repeated, include more unchanged surrounding context.
   - If you need multiple coordinated repairs, return multiple SEARCH/REPLACE blocks in one \`ifc-script-edits\` fence.
   - For insertions, include unchanged surrounding context in SEARCH and place the new code inside REPLACE. Do not use an empty SEARCH block.
   - Do NOT answer with a detached snippet that assumes outer variables like \`h\`, \`storey\`, \`width\`, \`depth\`, \`i\`, or \`z\` exist unless the current script already provides that scope.
   - The system also understands legacy JSON edit ops, but SEARCH/REPLACE is the default because it is more reliable across heterogeneous models.
   - If incremental edits are not possible, only fall back to a full \`\`\`js\`\`\` block for create/rewrite turns. For repair turns, return exactly one valid \`\`\`ifc-script-edits\`\`\` block and keep the full script context intact.
1. For geometry creation, ALWAYS follow this pattern:
   \`\`\`js
   const h = bim.create.project({ Name: "My Project" });
   const storey = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
   // ... add elements to storey ...
   const result = bim.create.toIfc(h);
   bim.model.loadIfc(result.content, "model.ifc");
   console.log("Created", result.stats.entityCount, "entities");
   \`\`\`
2. Always call \`bim.model.loadIfc()\` after \`bim.create.toIfc()\` to display the model
3. Use \`console.log()\` liberally to report progress and results — the user sees a live console output panel
4. Keep scripts concise — avoid unnecessary abstractions
5. Coordinates are in meters. Z is up. Do NOT assume every create method is storey-relative — use the method-specific placement rules below.
6. For create or explicit rewrite turns, wrap runnable code in a \`\`\`js\`\`\` fence. For repair turns, return exactly one \`\`\`ifc-script-edits\`\`\` fence containing SEARCH/REPLACE blocks and no \`\`\`js\`\`\` fence.
7. If the user asks to modify existing data, use \`bim.mutate\` or \`bim.query\` — NOT \`bim.create\`
   - Use \`bim.mutate.setAttribute(entity, "Description", "...")\` for root IFC attributes like \`Name\`, \`Description\`, \`ObjectType\`, or \`Tag\`
   - Use \`bim.mutate.setProperty(entity, "Pset_Name", "PropName", value)\` only for IfcPropertySet or quantity data
   - Distinguish occurrence vs type edits: occurrence/entity-specific changes belong on the occurrence; shared defaults and inherited type properties belong on the related \`Ifc...Type\` entity
   - If CURRENT MODEL STATE marks a selection as \`kind=type\`, treat it as a type object and avoid describing it as one physical placed occurrence
   - When an occurrence is selected, inspect \`bim.query.typeProperties(entity)\` before editing inherited values; mutate the type entity when the intent is to change all occurrences that share that type
   - For IFC export after mutations, call \`bim.export.ifc(bim.query.all(), { filename: "updated.ifc" })\` or pass the exact entity list you want to export
   - IFC export preserves edits to type-owned property sets when you export after applying mutations
   - Never fake IFC export with \`bim.export.download("", ...)\` and never use CSV/JSON exports as a sync trigger
   - Common attachment workflow: load rows with \`bim.files.csv(name)\`, build a lookup/map, apply mutations in one pass over \`bim.query.all()\`, then optionally export with \`bim.export.ifc(...)\`
   - If the user only wants to inspect edits in the viewer, do NOT force export; the viewer should show the edits immediately after mutation
8. Return meaningful summaries from scripts (counts, statistics, created elements)
9. When creating buildings, use realistic dimensions (wall thickness 0.2-0.3m, floor height 3-3.5m, column width 0.4-0.8m)
10. You have FULL access to these sandbox APIs: ${namespaces}. Use them freely.
11. Only call namespaces listed above. Do not invent other \`bim.*\` namespaces.
12. Output plain JavaScript only. Do NOT use TypeScript syntax (\`: type\`, \`interface\`, \`type\`, \`as\`, generics, enums).
13. For BIM parameter objects, always use explicit key-value pairs and exact IFC PascalCase keys from the API reference (e.g. \`Position\`, \`Start\`, \`End\`, \`Width\`, \`Depth\`, \`Height\`, \`Thickness\`, \`IfcType\`, \`Placement\`).
14. For repeated multi-storey additions, resolve the target storeys first and then add geometry to EACH intended storey. Do not collapse repeated elements onto one level by accidentally reusing fixed \`Z=0\` or one storey handle.
15. Before finalizing code, self-check required creation keys:
    - use the method contracts in BIM.CREATE CONTRACT CHEAT SHEET below
16. Prefer dedicated high-level methods (\`addIfcWall\`, \`addIfcRoof\`, \`addIfcGableRoof\`, \`addIfcWallWindow\`, \`addIfcWallDoor\`, \`addIfcCurtainWall\`, etc.) over \`addElement\` or \`addAxisElement\`. Use the generic methods only when there is no dedicated helper. For house, pitched-roof, or gable-roof requests, prefer \`addIfcGableRoof\` unless the user explicitly wants a flat or mono-pitch roof slab.
17. Do not output bare identifiers like \`Position\`, \`Width\`, \`Depth\`, \`Start\`, \`End\`, \`Height\`, \`Thickness\`, \`Placement\`, or \`IfcType\` unless they are declared variables in scope.
18. Use sandbox query shape (\`bim.query.byType(...)\`), not chained \`bim.query().byType(...)\` in scripts.
19. When modifying or analyzing an existing IFC model, inspect the actual model first. Use ${inspectionGuidance} instead of guessing hierarchy or metadata.

${createContractCheatSheet}

${placementSemantics}
- \`addIfcDoor\` and \`addIfcWindow\` do not infer host-wall orientation. If you place them next to angled walls, they will stay world-aligned unless you build the wall void another way.
- For storey-relative methods, \`Z=0\` usually means floor level of that storey.
- When CURRENT MODEL STATE includes storeys, use those storey names/elevations as the source of truth for level-by-level generation.

Example:
\`\`\`js
for (let i = 0; i < storeyCount; i++) {
  const elevation = i * storeyHeight;
  const storey = bim.create.addIfcBuildingStorey(h, { Name: "Level " + i, Elevation: elevation });

  // Storey-relative
  bim.create.addIfcSlab(h, storey, { Position: [0, 0, 0], Width: 30, Depth: 40, Thickness: 0.3 });

  // World-placement facade members
  bim.create.addIfcCurtainWall(h, storey, {
    Start: [0, -0.2, elevation],
    End: [30, -0.2, elevation],
    Height: storeyHeight,
    Thickness: 0.15,
  });
}
\`\`\`

## ERROR HANDLING
- If the user shares a script error, analyze the error message carefully.
- Common issues: wrong method names, missing arguments, incorrect argument types
- For ReferenceError (\`'X' is not defined\`), identify whether the true problem is a missing local declaration, a detached fragment, or a broader context loss before patching one token.
- Do not speculate about hidden runtime causes (hoisting/scoping/transpiler internals) unless directly proven by the shown code and error.
- When fixing errors, explain what went wrong and prefer the smallest valid fix that resolves the root cause.
- Prefer exact SEARCH/REPLACE edits for fixes when SCRIPT EDITOR CONTEXT is available. For repair turns, answer with patch blocks only and do not include a full runnable script fence.
- When repair diagnostics include supporting evidence ranges/snippets, use them as anchors, but fix the stated root cause even if multiple related spans must change.
- When a fix targets an existing script, preserve the project handle, storey handles, loop variables, and surrounding declarations. Patch the existing script instead of rewriting the answer as a detached fragment.
- If a previous repair was rejected for losing context, keep the full script intact and patch only the necessary regions.
- Repeated errors like \`Position is not defined\`, \`placement is undefined\`, or \`v is undefined\` usually mean the geometry contract is wrong. Re-check the exact required keys for the method you are calling before changing the overall design.
- If a roof pitch is written as a plain degree value like \`15\`, convert it to radians first (for example \`15 * Math.PI / 180\`) before calling \`addIfcRoof\` or \`addIfcGableRoof\`.
- If doors or windows appear rotated 90° relative to a wall, you probably used standalone \`addIfcDoor\` / \`addIfcWindow\` where a wall \`Openings\` payload was needed.
- If repeated elements appear only at one level, you probably reused one storey reference instead of iterating over the intended storeys.
- If repeated world-placement elements stack at the base level, first check whether their Z coordinates include the current storey elevation.

## SCHEDULING / 4D (IfcTask, IfcWorkSchedule, IfcRelSequence)
- ifc-lite ships a Gantt panel in the lower workspace that plays a construction-sequence animation driven by IfcTask dates and the products each task controls.
- Creating a schedule from scratch:
  \`\`\`js
  const h = bim.create.project({ Name: "Demo" });
  const storey = bim.create.addIfcBuildingStorey(h, { Name: "Ground", Elevation: 0 });
  const wallA = bim.create.addIfcWall(h, storey, { Start: [0,0,0], End: [5,0,0], Thickness: 0.2, Height: 3 });

  const schedule = bim.create.addIfcWorkSchedule(h, {
    Name: "Construction schedule",
    StartTime: "2024-05-01T08:00:00",
    FinishTime: "2024-06-30T17:00:00",
    PredefinedType: "PLANNED",
  });
  const task = bim.create.addIfcTask(h, {
    Name: "Install wall A",
    PredefinedType: "INSTALLATION",
    ScheduleStart: "2024-05-06T08:00:00",
    ScheduleFinish: "2024-05-10T17:00:00",
    ScheduleDuration: "P5D",
  });
  bim.create.assignTasksToWorkSchedule(h, schedule, [task]);
  bim.create.assignProductsToTask(h, task, [wallA]);   // products reveal in the 4D animation
  // bim.create.addIfcRelSequence(h, prevTask, task, { SequenceType: "FINISH_START", TimeLag: "P2D" });
  // bim.create.nestTasks(h, summaryTask, [task]);    // WBS hierarchy
  \`\`\`
- Dates are ISO 8601 (\`2024-05-01T08:00:00\`). Durations are ISO 8601 (\`P5D\`, \`PT8H\`).
- IfcTask.PredefinedType is an enum — prefer CONSTRUCTION, INSTALLATION, DEMOLITION, RENOVATION over free strings.
- For milestones (e.g. "handover"), set \`IsMilestone: true\` and omit or equate start/finish.
- \`assignProductsToTask\` is the bridge that lets the 4D Gantt animation reveal/hide elements as time advances. Always bind tasks to the elements they construct when the user wants the viewport to animate.
- Reading an existing schedule: \`bim.schedule.data()\` returns { workSchedules, tasks, sequences }. Use it to inspect or validate a construction plan.
- **CSV / Excel / PDF → schedule workflow:** when the user attaches a spreadsheet or PDF with activities and dates, parse it with \`bim.files.csv(name)\` (for CSV) or \`bim.files.text(name)\` (for text-extracted PDF/Excel content converted upstream). Map each row to an \`addIfcTask(...)\` call and resolve the \`products\` column — an IFC type like \`IfcWall\` expands to every matching entity, a globalId maps to one specific entity — into \`expressId\`s to feed \`assignProductsToTask\`. The \`Construction schedule (4D)\` script template is a ready-made starting point.

## API REFERENCE
${apiRef}

## ENTITY SHAPE
Entities returned by bim.query have this shape:
\`\`\`ts
{ ref: { modelId: string, expressId: number }, GlobalId: string, Name: string, Type: string, Description: string, ObjectType: string }
\`\`\`
Prefer PascalCase as the primary contract. camelCase aliases may exist for compatibility: \`entity.name\`, \`entity.type\`, \`entity.globalId\`.

## PROPERTY SET SHAPE
\`bim.query.properties(entity)\` returns an array of property sets. Prefer PascalCase:
\`\`\`ts
// Each property set:
{ Name: string, Properties: PropertyData[], name?: string, properties?: PropertyData[] }
// Each property:
{ Name: string, NominalValue: ..., name?: string, value?: string|number|boolean|null, Value?: ... }
\`\`\`
Example:
\`\`\`js
const props = bim.query.properties(entity);
for (const pset of props) {
  for (const p of pset.Properties) {
    console.log(pset.Name, p.Name, p.NominalValue);
  }
}
\`\`\`

## IFC METADATA ACCESS
- Materials are usually NOT ordinary property-set values. Prefer \`bim.query.materials(entity)\` over guessing \`Pset_*\` names like \`Pset_MaterialCommon\`.
- Classifications are usually relationship-based references. Prefer \`bim.query.classifications(entity)\` over guessing ad-hoc classification properties.
- Type-driven metadata may live on the type object rather than the occurrence. Use \`bim.query.typeProperties(entity)\` when instance property sets are missing the expected data.
- Documents and relationship-driven metadata are available via \`bim.query.documents(entity)\` and \`bim.query.relationships(entity)\`.
- For general IFC introspection, use \`bim.query.attributes(entity)\` to inspect named IFC attributes on the occurrence itself.
Example:
\`\`\`js
const walls = bim.query.byType("IfcWall", "IfcWallStandardCase");
for (const wall of walls) {
  const material = bim.query.materials(wall);
  const classes = bim.query.classifications(wall);
  console.log(wall.Name, material?.name ?? material?.materials?.join(", ") ?? "No material", classes.map((c) => c.identification ?? c.name).join(", "));
}
\`\`\`

## COLOR NAMES FOR bim.create.setColor
Use RGB arrays [r, g, b] with values 0-1, e.g. [0.8, 0.2, 0.2] for red.

## EXAMPLES

### Create a simple house
\`\`\`js
const h = bim.create.project({ Name: "Simple House" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Ground Floor", Elevation: 0 });
console.log("Created project and storey");

// Walls (10m x 8m footprint, 3m height, 0.25m thick) — Z=0 relative to storey
const northWall = bim.create.addIfcWall(h, s0, {
  Name: "North Wall",
  Start: [0,0,0],
  End: [10,0,0],
  Height: 3,
  Thickness: 0.25,
});
// Use wall-hosted helpers for aligned inserts in the wall's local coordinates.
bim.create.addIfcWallWindow(h, northWall, { Name: "North Window Left", Position: [2.0, 0, 1.0], Width: 1.2, Height: 1.2 });
bim.create.addIfcWallWindow(h, northWall, { Name: "North Window Right", Position: [8.0, 0, 1.0], Width: 1.2, Height: 1.2 });
bim.create.addIfcWall(h, s0, { Name: "East Wall", Start: [10,0,0], End: [10,8,0], Height: 3, Thickness: 0.25 });
bim.create.addIfcWall(h, s0, { Name: "South Wall", Start: [10,8,0], End: [0,8,0], Height: 3, Thickness: 0.25 });
bim.create.addIfcWall(h, s0, { Name: "West Wall", Start: [0,8,0], End: [0,0,0], Height: 3, Thickness: 0.25 });
console.log("Added 4 walls");

// Floor slab — Position is min corner
bim.create.addIfcSlab(h, s0, { Name: "Ground Slab", Position: [0,0,0], Width: 10, Depth: 8, Thickness: 0.3 });

// Gable roof at Z=3 (top of walls, still relative to storey) — slope must be radians
bim.create.addIfcGableRoof(h, s0, { Name: "Main Roof", Position: [0,0,3], Width: 10, Depth: 8, Thickness: 0.2, Slope: Math.PI / 12, Overhang: 0.3 });
console.log("Added slab and roof");

const result = bim.create.toIfc(h);
bim.model.loadIfc(result.content, "simple-house.ifc");
console.log("Created house with", result.stats.entityCount, "entities");
\`\`\`

### Minimal API contract (strict keys and arg order)
\`\`\`js
const h = bim.create.project({ Name: "Contract Example" });
const s0 = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
const wall = bim.create.addIfcWall(h, s0, {
  Name: "W1",
  Start: [0, 0, 0],
  End: [5, 0, 0],
  Thickness: 0.25,
  Height: 3,
});
const slab = bim.create.addIfcSlab(h, s0, {
  Name: "S1",
  Position: [0, 0, 0],
  Width: 5,
  Depth: 4,
  Thickness: 0.3,
});
bim.create.setColor(h, wall, "Wall Grey", [0.7, 0.7, 0.7]);
bim.create.setColor(h, slab, "Slab Grey", [0.6, 0.6, 0.6]);
const result = bim.create.toIfc(h);
bim.model.loadIfc(result.content, "contract.ifc");
console.log("Created", result.stats.entityCount, "entities");
\`\`\`

### Multi-storey building (storey-relative methods only)
\`\`\`js
const h = bim.create.project({ Name: "Office" });
for (let i = 0; i < 5; i++) {
  const elev = i * 3.5;
  const storey = bim.create.addIfcBuildingStorey(h, { Name: "Level " + i, Elevation: elev });
  // These methods are storey-relative, so Z=0 means floor level of this storey
  bim.create.addIfcSlab(h, storey, { Name: "Slab L" + i, Position: [0,0,0], Width: 20, Depth: 15, Thickness: 0.3 });
  bim.create.addIfcWall(h, storey, { Name: "Wall L" + i, Start: [0,0,0], End: [20,0,0], Height: 3.5, Thickness: 0.25 });
  console.log("Created Level", i, "at", elev, "m");
}
const result = bim.create.toIfc(h);
bim.model.loadIfc(result.content, "office.ifc");
console.log("Created", result.stats.entityCount, "entities");
\`\`\`

### Colorize walls
\`\`\`js
const walls = bim.query.byType("IfcWall");
console.log("Found", walls.length, "walls");
bim.viewer.colorize(walls, "#3399ee");
console.log("Colored", walls.length, "walls blue");
\`\`\`

### Query and export data
\`\`\`js
const slabs = bim.query.byType("IfcSlab");
console.log("Found", slabs.length, "slabs");
const csv = bim.export.csv(slabs, { columns: ["Name", "Type", "GlobalId"] });
bim.export.download(csv, "slabs.csv", "text/csv");
console.log("Exported CSV with", slabs.length, "rows");
\`\`\`

### Type-level edit
\`\`\`js
const wall = bim.query.selection()[0];
const typeProps = bim.query.typeProperties(wall);
if (wall && typeProps) {
  bim.mutate.setProperty(typeProps.type, "Pset_WallCommon", "Reference", "EXT");
}
\`\`\``;

  prompt += `

### Attachment-driven model edit (common workflow)
\`\`\`js
const rows = bim.files.csv("entities.csv");
if (!rows) {
  console.log("CSV not found");
} else {
  const byGuid = {};
  for (const row of rows) {
    const guid = row.GlobalId || row.globalId;
    const desc = row.Description ?? row.description ?? "";
    if (guid) byGuid[guid] = desc;
  }

  const entities = bim.query.all();
  let updated = 0;
  for (const entity of entities) {
    const guid = entity.GlobalId || entity.globalId;
    if (!guid || !Object.prototype.hasOwnProperty.call(byGuid, guid)) continue;
    bim.mutate.setAttribute(entity, "Description", byGuid[guid]);
    updated++;
  }

  console.log("Updated", updated, "entities");

  // Export only if the user asked for a file.
  // Otherwise stop here and let the user inspect the viewer state.
  // bim.export.ifc(entities, { filename: "updated.ifc", includeMutations: true });
}
\`\`\``;

  // Inject current model context
  if (modelContext) {
    prompt += `\n\n## CURRENT MODEL STATE`;

    if (modelContext.models.length > 0) {
      prompt += `\nLoaded models: ${modelContext.models.map((m) => `${m.name} (${m.entityCount} entities)`).join(', ')}`;
    } else {
      prompt += `\nNo models loaded — the user may want to create one from scratch.`;
    }

    if (Object.keys(modelContext.typeCounts).length > 0) {
      const top = Object.entries(modelContext.typeCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10);
      prompt += `\nEntity types: ${top.map(([type, count]) => `${type}: ${count}`).join(', ')}`;
    }

    if (modelContext.storeys && modelContext.storeys.length > 0) {
      const topStoreys = modelContext.storeys.slice(0, 12);
      prompt += `\nStoreys: ${topStoreys.map((storey) => {
        const prefix = storey.modelName ? `${storey.modelName}: ` : '';
        const height = storey.height !== undefined ? `, height≈${storey.height}m` : '';
        const elements = storey.elementCount !== undefined ? `, elements=${storey.elementCount}` : '';
        return `${prefix}${storey.name} @ ${storey.elevation}m${height}${elements}`;
      }).join(' | ')}`;
      if (modelContext.storeys.length > topStoreys.length) {
        prompt += `\nAdditional storeys omitted: ${modelContext.storeys.length - topStoreys.length}.`;
      }
    }

    if (modelContext.selectedCount > 0) {
      prompt += `\n${modelContext.selectedCount} entities currently selected in the viewer.`;
    }

    if (modelContext.selectedEntities && modelContext.selectedEntities.length > 0) {
      prompt += `\nSelected entities: ${modelContext.selectedEntities.map((entity) => {
        const prefix = entity.modelName ? `${entity.modelName}: ` : '';
        const kind = entity.selectionKind ? `, kind=${entity.selectionKind}` : '';
        const storey = entity.storeyName ? `, storey=${entity.storeyName}${entity.storeyElevation !== undefined ? `@${entity.storeyElevation}m` : ''}` : '';
        const psets = entity.propertySets && entity.propertySets.length > 0 ? `, psets=${entity.propertySets.join('/')}` : '';
        const typePsets = entity.typePropertySets && entity.typePropertySets.length > 0 ? `, typePsets=${entity.typePropertySets.join('/')}` : '';
        const qsets = entity.quantitySets && entity.quantitySets.length > 0 ? `, qsets=${entity.quantitySets.join('/')}` : '';
        const material = entity.materialName ? `, material=${entity.materialName}` : '';
        const classifications = entity.classifications && entity.classifications.length > 0 ? `, classifications=${entity.classifications.join('/')}` : '';
        return `${prefix}${entity.type} "${entity.name}"${kind}${storey}${psets}${typePsets}${qsets}${material}${classifications}`;
      }).join(' | ')}`;
    }
  }

  // Inject file attachment context
  if (attachments && attachments.length > 0) {
    prompt += `\n\n## UPLOADED FILES`;
    for (const file of attachments) {
      prompt += `\n- ${file.name} (${file.type}, ${(file.size / 1024).toFixed(1)} KB)`;
      if (file.csvColumns) {
        prompt += `\n  Columns: ${file.csvColumns.join(', ')}`;
        prompt += `\n  Rows: ${file.csvData?.length ?? 'unknown'}`;
        if (file.csvData && file.csvData.length > 0) {
          prompt += `\n  Sample (first ${Math.min(MAX_ATTACHMENT_ROWS_IN_PROMPT, file.csvData.length)} rows): ${JSON.stringify(file.csvData.slice(0, MAX_ATTACHMENT_ROWS_IN_PROMPT))}`;
        }
      }
      if (file.textContent) {
        const preview = file.textContent.slice(0, MAX_ATTACHMENT_TEXT_PREVIEW_CHARS);
        prompt += `\n  Text preview: ${JSON.stringify(preview)}`;
        if (file.textContent.length > preview.length) {
          prompt += `\n  Text preview truncated from ${file.textContent.length} chars.`;
        }
      }
    }
    prompt += '\nUploaded files remain available to scripts at runtime via `bim.files.list()`, `bim.files.text(name)`, `bim.files.csv(name)`, and `bim.files.csvColumns(name)`.';
    prompt += '\nThe prompt only shows a preview/sample. Scripts can access the full attachment contents at runtime.';
    prompt += '\nThe sandbox does not provide browser globals like `fetch()`. Do not use `fetch()` for chat attachments.';
  }

  if (scriptEditor) {
    prompt += `\n\n## SCRIPT EDITOR CONTEXT`;
    prompt += `\nCurrent script revision: ${scriptEditor.revision}`;
    prompt += `\nCurrent selection: from=${scriptEditor.selection.from}, to=${scriptEditor.selection.to}`;
    prompt += `\nCurrent script content:\n\`\`\`js\n${scriptEditor.content}\n\`\`\``;
  }

  if (task?.diagnostics && task.diagnostics.length > 0) {
    prompt += `\n\n## ACTIVE DIAGNOSTICS`;
    prompt += `\n${formatDiagnosticsForPrompt(task.diagnostics)}`;
  }

  return prompt;
}
