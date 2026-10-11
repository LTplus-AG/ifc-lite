/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const newIfcEn = {
  'newIfc.title': 'Review new IFC file',
  'newIfc.scope': 'Create only a new project, native Site/Building and supplied storeys. Units and elevations must be supplied; no product geometry or design requirements are inferred.',
  'newIfc.noUndo': 'This creates a separate file. File download and replacing a viewer session are not authoring edits and have no model-edit Undo.',
  'newIfc.prepare': 'Prepare new IFC file', 'newIfc.preparing': 'Preparing native file…',
  'newIfc.preview': '{name}: {bytes} bytes, {count} native records; {schema}, {unit}.',
  'newIfc.defaults': 'Native identities, names and defaults', 'newIfc.content': 'Exact prepared IFC content',
  'newIfc.download': 'Download reviewed IFC', 'newIfc.downloaded': 'The approved bytes were published through the native download action.',
  'newIfc.loadWarning': 'Requesting a primary load replaces the current viewer session. Save current edits first. Native loading can still fail or be cancelled.',
  'newIfc.requestLoad': 'Request viewer load (replace session)',
  'newIfc.requested': 'Load requested, not confirmed. Follow native Activity and Load reports for the actual outcome.',
  'newIfc.modelsTitle': 'Models and new IFC files',
  'newIfc.modelsDescription': 'Discuss actual model load reports, or prepare a standalone native IFC scaffold from supplied schema, units and storeys.',
  'newIfc.capabilityReady': 'Native new-file scaffold available; no loaded-model facts',
  'newIfc.suggest': 'Prepare a new native IFC project and storeys using the schema, units and elevations I supply; ask for any missing input.',
} as const;
