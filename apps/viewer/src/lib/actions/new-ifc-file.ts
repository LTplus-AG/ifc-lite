/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CreateNamespace } from '@ifc-lite/sdk';
import { IfcParser, effectiveMetadataRecord, extractProjectUnits } from '@ifc-lite/parser';
import type { ProjectParams, StoreyParams } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { createModelAdapter } from '@/sdk/adapters/model-adapter';
import { useViewerStore } from '@/store';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import { isRecord, onlyKeys, requiredText, optionalText } from '@/lib/check-authoring/proposal-json';
export interface NewIfcProposal { version: 1; kind: 'ifc.create'; title: string; filename: string; project: ProjectParams & { Name: string; Schema: 'IFC4' | 'IFC4X3'; LengthUnit: 'METRE' | 'MILLIMETRE' }; storeys: Array<StoreyParams & { Name: string }> }
export const NEW_IFC_CAPABILITY = Object.freeze({ kind: 'native-new-ifc-scaffold', schemas: ['IFC4', 'IFC4X3'], LengthUnit: ['METRE', 'MILLIMETRE'], operations: ['project', 'addIfcBuildingStorey', 'toIfc'], suppliedFields: ['Name', 'Schema', 'LengthUnit', 'Description', 'Author', 'Organization', 'Currency', 'storeys.Name', 'storeys.Elevation'], nativeDefaults: { SiteName: 'Site', BuildingName: 'Building', GUIDs: 'native generated', timestamp: 'native preparation time' }, existingModelFacts: false, publication: 'explicit file download; optional primary viewer load request is not load completion or Undo', limitation: 'No product geometry, currency, units, elevations or engineering requirements may be inferred.' });
export const NEW_IFC_GUIDANCE = 'To create a standalone native project scaffold, use version:1 kind:"ifc.create", title, filename, project:{Name,Schema:"IFC4"|"IFC4X3",LengthUnit:"METRE"|"MILLIMETRE", optional Description/Author/Organization/Currency}, storeys:[{Name,Elevation}]. Every elevation uses the declared file units. Request missing user inputs; never infer units/currency/elevations, send code/raw STEP/GuidSource or arbitrary creator methods. This creates only a new standalone scaffold with native Site/Building defaults. Detached native preparation and explicit Download are required. Primary load is a separate request replacing the current session, not a completed load or an undoable edit.';
export function declaresNewIfc(content: string): boolean { return /"kind"\s*:\s*"ifc\.create"/.test(content); }
export function parseNewIfcProposal(content: string): NewIfcProposal {
  if (content.length > 20000) throw new Error('New IFC proposal exceeds the bounded scaffold limit');
  const trimmed = content.trim(), fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed), value: unknown = JSON.parse(fenced ? fenced[1] : trimmed);
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'ifc.create' || !isRecord(value.project)) throw new Error('Supply a version 1 native new-IFC scaffold proposal');
  onlyKeys(value, ['version', 'kind', 'title', 'filename', 'project', 'storeys'], 'New IFC');
  onlyKeys(value.project, ['Name', 'Schema', 'LengthUnit', 'Description', 'Author', 'Organization', 'Currency'], 'project');
  const Schema = value.project.Schema, LengthUnit = value.project.LengthUnit;
  if (Schema !== 'IFC4' && Schema !== 'IFC4X3') throw new Error('Supply supported native Schema IFC4 or IFC4X3');
  if (LengthUnit !== 'METRE' && LengthUnit !== 'MILLIMETRE') throw new Error('Supply literal supported native LengthUnit METRE or MILLIMETRE');
  const project: NewIfcProposal['project'] = { Name: requiredText(value.project, 'Name', 'project', 200), Schema, LengthUnit, Description: optionalText(value.project, 'Description', 'project'), Author: optionalText(value.project, 'Author', 'project', 200), Organization: optionalText(value.project, 'Organization', 'project', 200), Currency: optionalText(value.project, 'Currency', 'project', 20) };
  if (!Array.isArray(value.storeys) || value.storeys.length > 20) throw new Error('Supply a bounded explicit storeys array (up to 20, empty allowed)');
  const storeys = value.storeys.map((row, index) => { if (!isRecord(row)) throw new Error(`storeys[${index}] must be an object`); onlyKeys(row, ['Name', 'Elevation', 'Description'], `storeys[${index}]`); if (typeof row.Elevation !== 'number' || !Number.isFinite(row.Elevation)) throw new Error(`storeys[${index}].Elevation must be supplied in the declared file units`); return { Name: requiredText(row, 'Name', `storeys[${index}]`, 200), Elevation: row.Elevation, Description: optionalText(row, 'Description', `storeys[${index}]`) }; });
  return { version: 1, kind: 'ifc.create', title: requiredText(value, 'title', 'New IFC', 200), filename: requiredText(value, 'filename', 'New IFC', 200), project, storeys };
}
function workspace(state: ViewerState) { return [...state.models].map(([id, model]) => ({ id, model, store: model.ifcDataStore, source: model.ifcDataStore?.source, hash: model.sourceContentHash, fingerprint: model.sourceFingerprint, view: state.mutationViews.get(id), revision: state.mutationViews.get(id)?.getMutationRevision() })); }
export async function prepareNewIfcFile(input: NewIfcProposal) {
  const proposal = parseNewIfcProposal(JSON.stringify(input)), ownership = JSON.stringify(proposal), savedWorkspace = workspace(useViewerStore.getState());
  const creator = new CreateNamespace().project(proposal.project); for (const storey of proposal.storeys) creator.addIfcBuildingStorey(storey);
  const result = creator.toIfc(), content = result.content, bytes = new TextEncoder().encode(content);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  // @raw-entity-enumeration-ok Detached native exported scaffold parse, before any overlay or model registration.
  const projectId = parsed.entityIndex.byType.get('IFCPROJECT')?.[0]; if (!projectId) throw new Error('Native file has no project');
  const units = extractProjectUnits(parsed.source, parsed.entityIndex, projectId).resolvedForUnitType('LENGTHUNIT');
  if (!units || units.siScale !== (proposal.project.LengthUnit === 'MILLIMETRE' ? 0.001 : 1)) throw new Error('Native exported units differ from the approved supplied unit');
  const roots = result.entities.map(entity => { const record = effectiveMetadataRecord(parsed, entity.expressId); if (!record || typeof record.attributes[0] !== 'string' || !/^[0-3][0-9A-Za-z_$]{21}$/.test(record.attributes[0])) throw new Error('Native scaffold Root identity is unavailable'); return { expressId: entity.expressId, type: record.type, GlobalId: record.attributes[0], Name: record.attributes[2] ?? null }; });
  if (new Set(roots.map(root => root.GlobalId)).size !== roots.length) throw new Error('Native scaffold identities are ambiguous');
  const filename = sanitizeFilename(proposal.filename.replace(/\.ifc$/i, '')) + '.ifc'; let downloaded = false, requested = false;
  const validate = () => { if (JSON.stringify(proposal) !== ownership) throw new Error('The reviewed file definition changed; prepare again'); };
  return { proposal, content, filename, roots, entityCount: result.stats.entityCount, byteLength: bytes.byteLength, lengthUnitScale: units.siScale, validate,
    download() { validate(); if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') throw new Error('Browser download is unavailable'); if (downloaded) throw new Error('This approved file was already downloaded'); downloadFile(content, filename, 'application/x-step;charset=utf-8'); downloaded = true; },
    requestPrimaryLoad() {
      validate(); if (requested) throw new Error('This file load was already requested'); const state = useViewerStore.getState();
      if (state.loading) throw new Error('A native load is running; wait before requesting this file');
      if (state.dirtyModels.size || state.collabRoomId) throw new Error('Save or leave the current edited/shared session before requesting a replacement');
      const current = workspace(state); if (savedWorkspace.length !== current.length || savedWorkspace.some((row, index) => Object.keys(row).some(key => row[key as keyof typeof row] !== current[index][key as keyof typeof row]))) throw new Error('The current workspace changed after file preparation; prepare again before replacement');
      createModelAdapter(useViewerStore).loadIfc(content, filename); requested = true;
    },
  };
}
export type NewIfcFileReview = Awaited<ReturnType<typeof prepareNewIfcFile>>;
