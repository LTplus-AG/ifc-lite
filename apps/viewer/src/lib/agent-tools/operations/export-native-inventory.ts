/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Finite toolbar registry inventory. Panel-specific artifacts are separate. */
export const nativeExportRegistryInventory = [
  { registry_id: 'ifc', operations: ['exports.models', 'exports.modelStep', 'exports.mergedStep', 'exports.modelIfcx', 'exports.landXmlIfc'], owner: 'parent' },
  { registry_id: 'modified-ifc', operations: ['exports.changedModels'], owner: 'parent' },
  { registry_id: 'anonymized', operations: ['exports.anonymized.prepare', 'exports.anonymized'], controls: ['source-model seeds', 'native relationship expansion and depth', 'locked spatial context', 'individual/type exclusions', 'all native anonymization toggles', 'neutral filename'] },
  { registry_id: 'glb', operations: ['exports.glb'], controls: ['one model', 'visible only', 'metadata', 'rendering/shading color', 'lit/unlit'] },
  { registry_id: 'kmz', operations: ['exports.kmz'], controls: ['one model', 'ground-clamped/MSL altitude', 'native effective georeference'] },
  { registry_id: 'usd', operations: ['exports.usd'], controls: ['one native STEP-source model', 'pending edits', 'USDA'] },
  { registry_id: '3dm', operations: ['exports.rhino'], controls: ['one model', 'version', 'units', 'local/world', 'layer scheme', 'instancing', 'properties', 'spaces', 'visible only', 'native worker cancellation'] },
  { registry_id: 'energy', operations: ['exports.energy'], controls: ['one model', 'HBJSON/DFJSON', 'edited source and authored spaces', 'native skipped-space diagnostics'] },
  { registry_id: 'landxml-terrain', operations: ['exports.terrainLandXml'], controls: ['one model', 'explicit terrain products', 'units', 'decimals', 'surface names', 'native producer preflight/refusal'] },
  { registry_id: 'cityjson', operations: ['exports.cityjson'], controls: ['one model', 'CityJSON or CityJSONSeq', 'local-coordinate fallback', 'producer warnings and refusals'] },
  { registry_id: 'csv', operations: ['exports.csv'], controls: ['explicit single model', 'entities/properties/quantities/spatial', 'current pending edits'] },
  { registry_id: 'json', operations: ['exports.json'], controls: ['explicit single model', 'native effective entity envelope'] },
  { registry_id: 'screenshot', operations: ['exports.screenshot'], controls: ['current viewport PNG', 'native frame capture'] },
  { registry_id: 'pdf', operations: ['exports.viewPdf'], controls: ['current view and every section cut', 'displayed/numerical drafting scale', 'shaded/lines', 'hidden edges', 'scale stamp', 'native printable-size gate'] },
  { registry_id: 'ion', operations: [], classification: 'native-credential-and-publication-boundary', native: 'CesiumIonExportDialog + cesium-ion service require personal access token, target asset settings and native upload/review. No credentials, uploads or remote asset creation are performed by these artifact operations.' },
  { registry_id: 'extension', operations: [], classification: 'extension-host-boundary', native: 'Runtime exportMenu contributions belong to the live ExtensionHost. Native owner-qualified invokeExporter, installed-slot membership, host lifetime, busy state, permission and extension review contracts remain authoritative. There is no generic arbitrary-method bridge.' },
] as const;
