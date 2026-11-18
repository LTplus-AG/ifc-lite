/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georeferencing doctor as tools: `georeferencing_check` (read) returns
 * the `bim.georef.check()` report and the fix plan as JSON;
 * `georeferencing_fix` (mutate) applies the plan's `ready` fixes in the
 * session and checks again. The safety rules are the SDK's: only fixes that
 * go through the georeferencing write API with every value known, never one
 * the checker marks uncertain, and the network only when asked.
 */

import { GeoreferencingError, type GeorefCheckReport, type GeorefFixPlanOptions } from '@ifc-lite/sdk';
import type { Tool } from './types.js';
import type { JsonSchema } from '../protocol/index.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

const PLAN_PROPS: Record<string, JsonSchema> = {
  apply: { type: 'array', items: { type: 'string' }, description: 'Fix ids (from georeferencing_check) to use instead of their finding\'s preferred fix.' },
  values: {
    type: 'object',
    additionalProperties: { type: ['string', 'number'] },
    description: 'Values only the user can supply, by path: {"ProjectedCRS.Name": "EPSG:2056", "MapConversion.Eastings": 2600000, "IfcSite.RefLatitude": 47.1}. Never invent them.',
  },
  accept_approximate_datum: { type: 'boolean', description: 'Allow a site latitude/longitude derived through a Helmert approximation (no datum grid). Only when the user accepts metre-level error.' },
  allow_network: { type: 'boolean', description: 'Allow fetching EPSG definitions (epsg.io) and datum grids (cdn.proj.org). Off by default.' },
};

function planOptions(input: Record<string, unknown>): GeorefFixPlanOptions {
  const values = (input.values ?? {}) as Record<string, string | number>;
  for (const path of Object.keys(values)) {
    if (!/^(ProjectedCRS|MapConversion|IfcSite)\.[A-Za-z]+$/.test(path)) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `values: ${path} is not a path like ProjectedCRS.Name, MapConversion.Eastings or IfcSite.RefLatitude.` });
    }
  }
  return { choose: (input.apply as string[] | undefined) ?? [], values, acceptApproximateDatum: input.accept_approximate_datum === true };
}

/** The report without the raw coordinate sample (`facts`). */
function compact(report: GeorefCheckReport) {
  const { facts: _facts, ...rest } = report;
  return rest;
}

function summary(report: GeorefCheckReport): string {
  const lines = [`LoGeoRef ${report.level}; ${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}.`];
  for (const f of report.findings) lines.push(`${f.severity} ${f.code}: ${f.message}`);
  if (report.skipped.length) lines.push(`Not checked: ${report.skipped.map((s) => `${s.code} (${s.reason})`).join('; ')}`);
  return lines.join('\n');
}

function asToolError(err: unknown): never {
  if (err instanceof RangeError) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: err.message });
  if (err instanceof GeoreferencingError) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: err.message, details: { georefCode: err.code, missing: [...err.missing] } });
  }
  throw err;
}

export const georeferencingCheckTool: Tool = {
  name: 'georeferencing_check',
  description: [
    'Diagnose a model\'s georeferencing: the Level of Georeferencing found, findings with stable codes (MAP_POSITION_APPLIED_TWICE, SCALE_UNIT_MISMATCH, EASTING_ZONE_PREFIX, LV03_LV95_MIX, OUTSIDE_CRS_AREA, SITE_LOCATION_DEFAULT, …), checks skipped for lack of a capability, and a fix plan.',
    'Each planned fix has a status: ready (georeferencing_fix applies it), needs-value (pass the listed paths in values, from the user), review (the checker marks it uncertain; never applied), manual, alternative (pass its id in apply), conflict.',
    'Offline unless allow_network. Reads this session\'s unsaved edits as they would be saved.',
  ].join(' '),
  scope: 'read',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' }, ...PLAN_PROPS }, additionalProperties: false },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    try {
      const report = await m.bim.georef.check({ allowNetwork: input.allow_network === true });
      const plan = m.bim.georef.planFixes(report, planOptions(input));
      return okResult(summary(report), { report: compact(report), plan });
    } catch (err) {
      return asToolError(err);
    }
  },
};

export const georeferencingFixTool: Tool = {
  name: 'georeferencing_fix',
  description: [
    'Apply the georeferencing fixes georeferencing_check marks ready (same inputs: apply, values, accept_approximate_datum), held in the session like georeferencing_write and saved by export_ifc / model_save, then check again.',
    'Never applies a fix that needs a value nobody supplied, that the checker marks uncertain, or that the write API cannot carry; returns what was applied and what remains.',
  ].join(' '),
  scope: 'mutate',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' }, ...PLAN_PROPS }, additionalProperties: false },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    try {
      const allowNetwork = input.allow_network === true;
      const report = await m.bim.georef.check({ allowNetwork });
      const plan = m.bim.georef.planFixes(report, planOptions(input));
      const ready = plan.fixes.filter((f) => f.status === 'ready');
      if (ready.length === 0) {
        return okResult(`Nothing to apply.\n${summary(report)}`, { applied: [], plan, report: compact(report), after: null });
      }
      const result = m.bim.georef.fix(plan);
      const after = await m.bim.georef.check({ allowNetwork });
      const notes = result.writes.flatMap((w) => w.notes);
      return okResult(
        [`Applied ${result.applied.join(', ')} (unsaved; save with export_ifc or model_save).`, ...notes, `After: ${summary(after)}`].join('\n'),
        { applied: result.applied, notes, plan, after: { report: compact(after), plan: m.bim.georef.planFixes(after) } },
      );
    } catch (err) {
      return asToolError(err);
    }
  },
};
