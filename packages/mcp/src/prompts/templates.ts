/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pre-baked prompt templates (spec §9). The aim is the same as Claude
 * Code's slash commands: package the "BIM expert" intent + the right tool
 * sequence so a non-power user gets a useful answer in one click.
 *
 * Templates are pure text — no eval, no interpolation beyond `${arg}`.
 */

import type { Prompt } from './types.js';

function userMessage(text: string) {
  return { role: 'user' as const, content: { type: 'text' as const, text } };
}

function systemMessage(text: string) {
  return { role: 'system' as const, content: { type: 'text' as const, text } };
}

export const auditModel: Prompt = {
  name: 'audit_model',
  description: 'Run the model_audit tool and explain the top issues by impact, suggesting fixes.',
  arguments: [{ name: 'model_id', description: 'Optional explicit model id.', required: false }],
  render(args) {
    return {
      description: 'Comprehensive model health check',
      messages: [
        systemMessage('You are a senior BIM modeler reviewing IFC quality.'),
        userMessage(
          [
            'Run `model_audit` on the loaded model',
            args.model_id ? ` (model_id="${args.model_id}")` : '',
            '. For each ERROR-severity issue, explain in plain language: ',
            '  • what the issue means for downstream tools (clash, IDS, takeoff), ',
            '  • why it usually happens, ',
            '  • a concrete one-line fix the modeler can apply (which tool to call, with what arguments). ',
            'Group warnings by category and only call them out individually if they affect more than 5% of entities.',
          ].join(''),
        ),
      ],
    };
  },
};

export const findFireRatedDoors: Prompt = {
  name: 'find_fire_rated_doors',
  description: 'Find doors that are missing or under-spec on fire rating, and prepare BCF topics.',
  arguments: [
    { name: 'minimum_rating', description: 'Minimum required rating (e.g. EI30).', required: false },
  ],
  render(args) {
    const minimum = args.minimum_rating ?? 'EI30';
    return {
      description: `Find doors with FireRating below ${minimum} or missing`,
      messages: [
        userMessage([
          `Use ifc-lite-mcp tools to:`,
          `1. \`query_entities\` for IfcDoor with property "Pset_DoorCommon.FireRating" missing OR not equal to "${minimum}".`,
          `2. For each non-compliant door, call \`bcf_topic_create\` titled "Fire rating below ${minimum} on <DoorName>" with the GlobalId in the description.`,
          `3. Attach a viewpoint with the door selected via \`bcf_viewpoint_create\`.`,
          `4. Report a summary of how many doors fail and the top 5 by name.`,
          `5. Offer to export the BCF via \`bcf_export\` to ./fire-rating-issues.bcfzip.`,
        ].join('\n')),
      ],
    };
  },
};

export const generateBcfFromIds: Prompt = {
  name: 'generate_bcf_from_ids',
  description: 'Run an IDS validation and create a BCF topic per failed entity.',
  arguments: [
    { name: 'ids_path', description: 'Path to .ids file.', required: true },
  ],
  render(args) {
    return {
      description: 'IDS → BCF',
      messages: [
        userMessage([
          'Validate the model against the IDS rule set, then create one BCF topic per failed entity.',
          '',
          `1. Call \`ids_validate\` with ids_path="${args.ids_path}".`,
          `2. For each failure with severity error, call \`bcf_topic_create\` (title=requirement name, description=failure reason).`,
          `3. Attach the failing entity GlobalId(s) via \`bcf_viewpoint_create\`.`,
          `4. End with \`bcf_export\` to ./ids-failures.bcfzip and report a summary table grouped by specification name.`,
        ].join('\n')),
      ],
    };
  },
};

export const lcaQuickLook: Prompt = {
  name: 'lca_quick_look',
  description: 'Run lca_compute, summarize total embodied carbon, and suggest the highest-leverage swap.',
  render() {
    return {
      description: 'KBOB-based carbon summary',
      messages: [
        userMessage([
          'Run `lca_compute` on the active model. Report:',
          '  • total GWP in kgCO₂eq and tCO₂eq,',
          '  • the top 5 elements by GWP with their material,',
          '  • how many elements were skipped due to missing volume or material (warn me if > 10%),',
          '  • one practical material swap suggestion using `lca_what_if` with the expected delta.',
        ].join('\n')),
      ],
    };
  },
};

export const compareVersions: Prompt = {
  name: 'compare_versions',
  description: 'Diff two loaded models and summarize material/quantity changes by storey.',
  arguments: [
    { name: 'a', description: 'Base model id.', required: true },
    { name: 'b', description: 'Head model id.', required: true },
  ],
  render(args) {
    return {
      description: `Diff ${args.a} vs ${args.b}`,
      messages: [
        userMessage([
          `Use \`model_diff\` to compare \`${args.a}\` and \`${args.b}\` (by_entity=true), then \`quantity_diff\` for IfcWall.Volume and IfcSlab.Area grouped by storey.`,
          `Output a markdown table per storey, flagging any group with > 10 % delta. Conclude with a one-line risk summary.`,
        ].join('\n')),
      ],
    };
  },
};

export const spaceProgramCheck: Prompt = {
  name: 'space_program_check',
  description: 'Compare IfcSpace areas to a target program, list deviations.',
  arguments: [{ name: 'program_csv', description: 'Path to program CSV (Name,TargetArea_m2).', required: true }],
  render(args) {
    return {
      description: 'Space program check',
      messages: [
        userMessage([
          `Read ${args.program_csv}, then for each row find IfcSpace entities by Name (case-insensitive) using \`query_entities\`.`,
          `Compute total NetFloorArea via \`geometry_area\` and compare to TargetArea_m2.`,
          `Output: name, target, actual, delta_m2, delta_pct, sorted by abs(delta_pct) desc. Flag rows where |delta_pct| > 5 %.`,
        ].join('\n')),
      ],
    };
  },
};

export const clashReview: Prompt = {
  name: 'clash_review',
  description: 'Run clash_check, group by trade, prioritize by severity.',
  render() {
    return {
      description: 'Clash review',
      messages: [
        userMessage('Run `clash_check` on the model. Group results by IFC type pair (e.g. IfcWall × IfcDuct) and produce a top-20 priority list for review.'),
      ],
    };
  },
};

export const propQualityPass: Prompt = {
  name: 'prop_quality_pass',
  description: 'Find entities with missing required properties and suggest values from bSDD.',
  arguments: [{ name: 'type', description: 'IFC type to focus on (default: IfcWall).', required: false }],
  render(args) {
    const type = args.type ?? 'IfcWall';
    return {
      description: 'Property quality pass',
      messages: [
        userMessage([
          `For all ${type} entities, list every property that is required by bSDD but missing in the model.`,
          `1. \`bsdd_property_sets\` for ${type}.`,
          `2. For each pset/property pair flagged "isIfcStandard", call \`properties_unique\` to see how often it's set.`,
          `3. Summarize coverage % and the worst offending pset/property combo.`,
        ].join('\n')),
      ],
    };
  },
};

export const migrateToIfcx: Prompt = {
  name: 'migrate_to_ifcx',
  description: 'Walk through migrating a model to IFC5/IFCX and flag attributes that don\'t translate cleanly.',
  render() {
    return {
      description: 'Migrate to IFCX',
      messages: [
        userMessage([
          'Plan a migration of the active model to IFC5/IFCX:',
          '  • use `schema_describe` to enumerate the entity types in use,',
          '  • flag deprecated attributes,',
          '  • call `export_ifcx` for a dry run and list any UNSUPPORTED_OPERATION codes,',
          '  • produce a migration checklist as bullet points.',
        ].join('\n')),
      ],
    };
  },
};

export const visualAudit: Prompt = {
  name: 'visual_audit',
  description: 'Open the 3D viewer, run model_audit, and paint problem entities so the user can see them at a glance.',
  arguments: [{ name: 'model_id', required: false }],
  render(args) {
    return {
      description: 'Visual model audit',
      messages: [
        userMessage(
          [
            'Workflow:',
            `1. \`viewer_ask\` (reason: "to highlight audit issues"). Wait for the user to confirm before opening.`,
            `2. \`viewer_open\`${args.model_id ? ` with model_id="${args.model_id}"` : ''}. Tell the user the URL.`,
            `3. \`model_audit\`. For each ERROR, find the entities with \`query_entities\` and \`viewer_colorize\` them red. For warnings, orange.`,
            `4. \`viewer_fly_to\` the worst issue so it's framed when the user opens the browser.`,
            `5. End with: "Pick any element in the viewer and I'll explain it." Then \`viewer_wait_for_selection\` and explain via \`get_entity\`.`,
          ].join('\n'),
        ),
      ],
    };
  },
};

export const interactivePropertyInspect: Prompt = {
  name: 'interactive_property_inspect',
  description: 'Open the viewer, wait for the user to click an entity, then explain everything we know about it.',
  arguments: [{ name: 'model_id', required: false }],
  render(args) {
    return {
      description: 'Inspect what the user picks',
      messages: [
        userMessage([
          `1. Confirm with \`viewer_ask\` (reason: "so you can pick the element you want me to inspect").`,
          `2. \`viewer_open\`${args.model_id ? ` with model_id="${args.model_id}"` : ''}.`,
          `3. \`viewer_wait_for_selection\` (timeout 120 s).`,
          `4. Once a pick lands, run \`get_entity\` with include=["attributes","properties","quantities","classifications","materials","relationships"].`,
          `5. Summarize for the user: type, GlobalId, name, key properties, materials, parent storey. Offer follow-ups (similar elements, BCF topic, bSDD lookup).`,
        ].join('\n')),
      ],
    };
  },
};

export const visualizeQuery: Prompt = {
  name: 'visualize_query',
  description: 'Run a query, then color-code matching entities so the user can see them.',
  arguments: [
    { name: 'type', required: true },
    { name: 'pset', required: false },
    { name: 'property', required: false },
  ],
  render(args) {
    return {
      description: `Visualize ${args.type}`,
      messages: [
        userMessage([
          `1. \`viewer_ask\` if not already open.`,
          `2. \`viewer_open\` if confirmed.`,
          args.pset && args.property
            ? `3. \`viewer_color_by_property\` with type="${args.type}", pset="${args.pset}", property="${args.property}". Share the legend.`
            : `3. \`viewer_isolate\` with type="${args.type}". Tell the user how many were highlighted.`,
          `4. \`viewer_fly_to\` the result set.`,
        ].join('\n')),
      ],
    };
  },
};

export const allPrompts: Prompt[] = [
  auditModel,
  findFireRatedDoors,
  generateBcfFromIds,
  lcaQuickLook,
  compareVersions,
  spaceProgramCheck,
  clashReview,
  propQualityPass,
  migrateToIfcx,
  visualAudit,
  interactivePropertyInspect,
  visualizeQuery,
];
