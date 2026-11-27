/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Georeferencing tools over `bim.georef`: the read tool (`georeferencing`)
 * and the write tool (`georeferencing_write`). Both report the SDK shape
 * (`GeoreferencingState`); an agent writes back the attribute fields it reads
 * (ProjectedCRS and MapConversion members), not the read-only ones (`type`,
 * `expressId`, `mapUnitResolved`, ...), which the write schema refuses.
 * A write is held in the session like any other mutation and lands in the
 * file with `export_ifc` / `model_save`.
 */

import { extractGeoreferencingOnDemand } from '@ifc-lite/parser';
import { epsgName, GeoreferencingError, type GeorefSiteInput, type GeoreferencingSetInput, type GeoreferencingUpdateInput, type GeoreferencingWriteResult } from '@ifc-lite/sdk';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { DESTRUCTIVE, READ_ONLY } from './annotations.js';

const CRS_PROPS = ['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone', 'MapUnit'];
const MC_PROPS = ['Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale', 'FactorX', 'FactorY', 'FactorZ'];

export const georeferencingReadTool: Tool = {
  name: 'georeferencing', title: 'Read georeferencing', annotations: READ_ONLY,
  description: 'Georeferencing of a model: IfcProjectedCRS + IfcMapConversion (IFC4X3: IfcMapConversionScaled, IfcRigidOperation; IFC2X3: ePSet_MapConversion/ePSet_ProjectedCRS; IfcSite lat/long fallback), rotation in degrees, and whether this session holds an unsaved georeferencing_write. `georef` uses the attribute names georeferencing_write takes (ProjectedCRS and MapConversion members); its read-only members (type, expressId, mapUnitResolved, source, storage, pending, untrusted, rotationDegrees, RigidOperation, site) are not inputs, so pass only the attribute fields back, never the whole object. `georeferencing` is the parser\'s source-only reading, kept for existing callers.',
  scope: 'read',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' } }, additionalProperties: false },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const georef = m.bim.georef.get();
    const crs = georef.ProjectedCRS;
    const mc = georef.MapConversion;
    const text = !georef.hasGeoreference
      ? 'No georeferencing.'
      : [
        `Georeferencing (${georef.source ?? crs?.type}${georef.pending ? ', unsaved session write' : ''}):`,
        crs ? `  CRS ${crs.Name}${crs.MapUnit ? `, MapUnit ${crs.MapUnit}` : ', no MapUnit'}` : '  no CRS',
        mc ? `  E ${mc.Eastings} N ${mc.Northings} H ${mc.OrthogonalHeight}${georef.rotationDegrees === null ? '' : `, rotation ${georef.rotationDegrees}°`}${mc.Scale === undefined ? '' : `, scale ${mc.Scale}`}` : '',
      ].filter(Boolean).join('\n');
    const note = georef.untrusted ? `\nValues may differ from the export (changed outside georeferencing_write): ${georef.untrusted.join('; ')}` : '';
    return okResult(text + note, { georef, georeferencing: extractGeoreferencingOnDemand(m.store) ?? null });
  },
};

function stringProps(names: string[]): Record<string, { type: 'string' }> {
  return Object.fromEntries(names.map((n) => [n, { type: 'string' as const }]));
}
function numberProps(names: string[]): Record<string, { type: 'number' }> {
  return Object.fromEntries(names.map((n) => [n, { type: 'number' as const }]));
}

export const georeferencingWriteTool: Tool = {
  name: 'georeferencing_write', title: 'Write georeferencing', annotations: DESTRUCTIVE,
  description: [
    'Set, update or remove a model\'s georeferencing, or write its IfcSite position. IFC4/IFC4X3 write IfcProjectedCRS + IfcMapConversion (IFC4X3 with FactorX/Y/Z: IfcMapConversionScaled); IFC2X3 writes the ePSet_MapConversion/ePSet_ProjectedCRS property sets on IfcSite (updates preserve an existing host).',
    'action "site" writes Site.RefLatitude/RefLongitude (decimal degrees, WGS84) and RefElevation (project length units) on the IfcSite (Site.siteId when there are several).',
    'set needs ProjectedCRS.Name (or epsg), ProjectedCRS.MapUnit (METRE with any SI prefix, FOOT, US SURVEY FOOT), and MapConversion.Eastings/Northings/OrthogonalHeight in map units; rotation as rotationDegrees or XAxisAbscissa+XAxisOrdinate.',
    'Fails closed with the missing input named: nothing is guessed, an existing georeferencing is replaced only with replace=true, a model without an IfcGeometricRepresentationContext (IFC2X3: IfcSite) is refused, contradicting values are refused. Saved by export_ifc / model_save.',
  ].join(' '),
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      action: { type: 'string', enum: ['set', 'update', 'remove', 'site'] },
      Site: {
        type: 'object',
        properties: { siteId: { type: 'integer', minimum: 1 }, RefLatitude: { type: 'number' }, RefLongitude: { type: 'number' }, RefElevation: { type: 'number' } },
        additionalProperties: false,
        description: 'action "site" only.',
      },
      ProjectedCRS: { type: 'object', properties: stringProps(CRS_PROPS), additionalProperties: false },
      MapConversion: { type: 'object', properties: numberProps(MC_PROPS), additionalProperties: false },
      epsg: { type: 'integer', minimum: 1, description: 'Convenience for ProjectedCRS.Name = "EPSG:<code>".' },
      rotationDegrees: { type: 'number', description: 'Counter-clockwise from map easting to the local x-axis. Alternative to XAxisAbscissa/XAxisOrdinate.' },
      replace: { type: 'boolean', description: 'set only: remove and replace an existing georeferencing.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    try {
      return writeGeoreferencing(input, ctx);
    } catch (err) {
      if (err instanceof GeoreferencingError) {
        throw new ToolExecutionError({
          code: err.code === 'UNSUPPORTED_SCHEMA' || err.code === 'UNSUPPORTED_RECORD' ? ToolErrorCode.UNSUPPORTED_OPERATION : ToolErrorCode.INVALID_INPUT,
          message: err.message,
          details: { georefCode: err.code, missing: [...err.missing] },
        });
      }
      throw err;
    }
  },
};

function writeSite(input: Record<string, unknown>, ctx: Parameters<Tool['handler']>[1]) {
  const m = resolveModel(ctx, input.model_id as string | undefined);
  if (input.ProjectedCRS || input.MapConversion || input.epsg !== undefined || input.rotationDegrees !== undefined || input.replace !== undefined) {
    throw invalid('action "site" takes only Site.');
  }
  const result = m.bim.georef.setSite((input.Site ?? {}) as GeorefSiteInput);
  return okResult(`IfcSite #${result.siteId} position queued; save with export_ifc or model_save.`, { action: 'site', site: result });
}

function writeGeoreferencing(input: Record<string, unknown>, ctx: Parameters<Tool['handler']>[1]) {
  if (input.action === 'site') return writeSite(input, ctx);
  if (input.Site !== undefined) throw invalid('Site applies to action "site" only.');
  const m = resolveModel(ctx, input.model_id as string | undefined);
  const action = input.action as 'set' | 'update' | 'remove';
  const crs = { ...(input.ProjectedCRS as Record<string, string> | undefined) };
  if (input.epsg !== undefined) {
    if (crs.Name !== undefined) throw invalid('Give the CRS once: ProjectedCRS.Name or epsg, not both.');
    crs.Name = epsgName(input.epsg);
  }
  if (action === 'remove' && (Object.keys(crs).length > 0 || input.MapConversion || input.rotationDegrees !== undefined || input.replace)) {
    throw invalid('remove takes no georeferencing values.');
  }
  if (action !== 'set' && input.replace !== undefined) throw invalid('replace applies to action "set" only.');
  const values: GeoreferencingUpdateInput = {
    ...(Object.keys(crs).length > 0 ? { ProjectedCRS: crs } : {}),
    ...(input.MapConversion ? { MapConversion: input.MapConversion as GeoreferencingUpdateInput['MapConversion'] } : {}),
    ...(input.rotationDegrees !== undefined ? { rotationDegrees: input.rotationDegrees as number } : {}),
  };
  const result: GeoreferencingWriteResult = action === 'set'
    ? m.bim.georef.set({ ...(values as GeoreferencingSetInput), replace: input.replace === true })
    : action === 'update' ? m.bim.georef.update(values) : m.bim.georef.remove();
  const lines = [`Georeferencing ${action} queued (${result.storage}); save with export_ifc or model_save.`];
  if (result.removed.length > 0) lines.push(`Removes: ${result.removed.join(', ')}.`);
  if (result.mapUnit) lines.push(`MapUnit ${result.mapUnit.value} (${result.mapUnit.detail}).`);
  lines.push(...result.notes);
  return okResult(lines.join('\n'), {
    action: result.action,
    storage: result.storage,
    removed: result.removed,
    mapUnit: result.mapUnit,
    notes: result.notes,
    georef: result.state,
  });
}

function invalid(message: string): ToolExecutionError {
  return new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}
