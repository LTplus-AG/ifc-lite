/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportEnergyArtifact } from '@ifc-lite/export';
import { cityJsonRefusalReason, exportCityJson } from '@ifc-lite/geometry';
import type { ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import { withIfcBytes } from './export-source.js';
import type { Tool } from './types.js';
import { fmtInt, resolveModel } from './util.js';

interface TextArtifact {
  text: string;
  warnings: string[];
}

async function writeArtifact(
  input: Record<string, unknown>,
  ctx: ToolContext,
  mimeType: string,
  produce: (bytes: Uint8Array, name: string) => Promise<TextArtifact>,
) {
  const model = resolveModel(ctx, input.model_id as string | undefined);
  const filePath = await resolveSafePath(input.file_path, ctx, 'write');
  const { text, warnings } = await withIfcBytes(model, (bytes) => produce(bytes, model.name));
  ctx.signal.throwIfAborted();
  const bytes = Buffer.byteLength(text);
  await writeFile(await resolveSafePath(filePath, ctx, 'write'), text, 'utf-8');
  return {
    content: [
      { type: 'text' as const, text: [`Wrote ${fmtInt(bytes)} bytes to ${filePath}.`, ...warnings].join('\n') },
      { type: 'resource_link' as const, uri: pathToFileURL(filePath).href, name: basename(filePath), mimeType, size: bytes },
    ],
    structuredContent: { filePath, bytes, warnings },
  };
}

const wholeModelOutput = {
  type: 'object' as const,
  properties: {
    filePath: { type: 'string' as const },
    bytes: { type: 'integer' as const },
    warnings: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['filePath', 'bytes', 'warnings'],
  additionalProperties: false,
};

const commonInput = {
  model_id: { type: 'string' as const, description: 'Loaded model ID. Defaults to the active model.' },
  file_path: { type: 'string' as const, description: 'Output path inside the allowed paths.' },
};

const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function cityTool(sequence: boolean): Tool {
  return {
    name: sequence ? 'export_cityjsonseq' : 'export_cityjson',
    title: sequence ? 'Export CityJSONSeq' : 'Export CityJSON',
    description: sequence
      ? 'CityJSONSeq export of the whole model, with one CityJSONFeature per building.'
      : 'CityJSON 2.0 export of the whole model, including buildings, spaces and elements.',
    scope: 'export',
    annotations,
    outputSchema: wholeModelOutput,
    inputSchema: {
      type: 'object',
      properties: {
        ...commonInput,
        scale: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Coordinate grid step in output units. Defaults to 0.001.' },
        blocks_only: { type: 'boolean', description: 'Keep rooms and elements as attribute-only objects.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    handler(input, ctx) {
      return writeArtifact(input, ctx, sequence ? 'application/x-ndjson' : 'application/json', async (bytes) => {
        try {
          return await exportCityJson(bytes, {
            sequence,
            scale: typeof input.scale === 'number' ? input.scale : undefined,
            elementGeometry: input.blocks_only !== true,
          });
        } catch (error) {
          const reason = cityJsonRefusalReason(error);
          if (reason === null) throw error;
          throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `CityJSON export refused: ${reason}` });
        }
      });
    },
  };
}

function energyTool(format: 'HBJSON' | 'DFJSON'): Tool {
  return {
    name: format === 'HBJSON' ? 'export_hbjson' : 'export_dfjson',
    title: `Export ${format}`,
    description: format === 'HBJSON'
      ? 'HBJSON export of Honeybee rooms, apertures, shades and constructions from the whole model.'
      : 'DFJSON export of Dragonfly Room2D plates grouped into stories from the whole model.',
    scope: 'export',
    annotations,
    outputSchema: wholeModelOutput,
    inputSchema: {
      type: 'object',
      properties: {
        ...commonInput,
        name: { type: 'string', description: 'Name of the energy model. Defaults to the loaded model name.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    handler(input, ctx) {
      return writeArtifact(input, ctx, 'application/json', (bytes, name) =>
        exportEnergyArtifact(format, bytes, typeof input.name === 'string' ? input.name : name));
    },
  };
}

export const cityAndEnergyExportTools = [cityTool(false), cityTool(true), energyTool('HBJSON'), energyTool('DFJSON')];
