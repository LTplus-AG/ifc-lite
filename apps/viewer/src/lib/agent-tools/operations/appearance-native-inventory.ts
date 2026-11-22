/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Finite current Appearance controls. No claim of new native geometry support. */
export const appearanceNativeControlBindings = [
  {
    controls: [
      'PDF page',
      'PDF quarter-turn',
      'physical-point crop',
      'requested raster DPI',
      'effective DPI/page extent/recipe',
    ],
    status: 'implemented',
    operations: ['appearance.source.inspect', 'appearance.pdf.raster'],
    boundary:
      'Native retained PDF document and raster worker own bounds/password/errors and asset lease transfer. An unavailable original PDF explicitly requires reimport; no second PDF parser or renderer.',
  },
  {
    controls: ['two source landmarks', 'known metric distance', 'stable image/PDF source calibration'],
    status: 'implemented',
    operations: ['appearance.source.inspect', 'appearance.source.calibrate'],
    boundary:
      'Same native raster coordinate conversion and complete-edit reducer as the calibration fields; incomplete/degenerate edits never replace a valid calibration.',
  },
  {
    controls: [
      'face editor product selection',
      'converted surface fingerprints',
      'supported-only scope narrowing',
      'triangle masks',
      'whole surface/reset mask',
      'Compare original/candidate',
    ],
    status: 'implemented',
    operations: [
      'appearance.plan',
      'appearance.faces.inspect',
      'appearance.faces.prepare',
      'appearance.compare',
      'appearance.applyPreview',
      'appearance.cancelPreview',
    ],
    boundary:
      'Same native mask reducer/request/reconciliation/planner and immutable analytics candidate. Masks bind native evaluated-occurrence fingerprints, not reused renderer triangle indices. Compare preserves the candidate and refuses applying/stale previews.',
  },
  {
    controls: [
      'reference prepare/place/edit',
      'reference source/calibration restore',
      'visibility/lock/opacity',
      'select/remove',
      'native reference Undo/Redo',
      'reference definitions import/export',
    ],
    status: 'implemented',
    operations: [
      'appearance.references.read',
      'appearance.references.restoreSource',
      'appearance.references.prepare',
      'appearance.references.place',
      'appearance.references.discard',
      'appearance.references.action',
      'appearance.references.export',
    ],
    boundary:
      'Exact native calibration and immutable image/PDF lineage, workspace frame and edit-record identity; shared native prepare/place handlers perform the same renderer publication/history write as the UI. Shared-room and source/frame changes refuse.',
  },
  {
    controls: [
      'capture textured source piece',
      'explicit region triangle selection',
      'create blank IFC4 destination',
      'destination model/container/name',
      'review/create IFC captured surface',
      'cancel creation',
    ],
    status: 'implemented',
    operations: [
      'appearance.capture.sources',
      'appearance.capture.destination',
      'appearance.capture.prepare',
      'appearance.capture.create',
      'appearance.capture.discard',
    ],
    boundary:
      'Same native captureRegistration/captureRegion/source asset, canonical loader and createIfcFromCapturedMesh multi-part IFC/GPU/history transaction. Async request cancellation reaches native planner; resource/role/frame guards stay active.',
  },
  {
    controls: [
      'scan GLB/point-cloud source and IFC destination',
      'restart binding',
      'fit/check source point/triangle landmark',
      'native visible IFC target pick',
      'remove/repartition/cancel pending correspondence',
      'registration calculate/cancel',
      'native fit/held-out residuals',
    ],
    status: 'implemented',
    operations: [
      'appearance.scan.sources',
      'appearance.scan.prepare',
      'appearance.scan.sourceLandmark',
      'appearance.scan.targetLandmark',
      'appearance.scan.edit',
      'appearance.scan.calculate',
      'appearance.scan.inspect',
    ],
    boundary:
      'Same native hashed session snapshots, source/target landmark handlers and duplicate/partition reducer, Rust registerScan worker and staleness proofs. Target input is native viewport CSS coordinates; source input uses retained triangle barycentrics or point index. Job/request cancellation aborts the native worker.',
  },
  {
    controls: [
      'scan target product set',
      'project tolerance and reviewed spread/errors',
      'mesh texture sampling settings',
      'point normal/neighborhood support settings',
      'coverage preview',
      'Compare',
      'apply/discard',
      'revalidate retained landmarks after appearance edits',
    ],
    status: 'implemented',
    operations: [
      'appearance.scan.transfer.prepare',
      'appearance.scan.transfer.compare',
      'appearance.scan.transfer.apply',
      'appearance.scan.transfer.discard',
      'appearance.scan.revalidate',
      'appearance.scan.inspect',
    ],
    boundary:
      'Exact native prepareMeshTransfer/staging/commitAppearance and unchanged-surface rebind. Native 4-fit/4-check, residual/project tolerance, source/coverage/exclusion and oriented-point support gates are preserved. Completed IFC edits report recovery required if subsequent revalidation fails/cancels; they are never reported rolled back.',
  },
  {
    controls: ['local image/PDF/scan bundle chooser', 'encrypted PDF password entry', 'reference image relink chooser'],
    status: 'native-input-boundary',
    operations: [],
    boundary:
      'These are browser File/password input controls. Operations act on registered retained sources and canonical loaded models; they do not expose password storage, arbitrary filesystem access or a second ingest path.',
  },
  {
    controls: [
      'PDF page thumbnail viewport',
      'face/capture canvas hover',
      'reference row expansion',
      'scan before/aligned preview',
      'landmark overlay labels',
      'preview render readiness/disclosures',
    ],
    status: 'presentation-only',
    operations: ['appearance.source.inspect', 'appearance.faces.inspect', 'appearance.scan.inspect'],
    boundary:
      'Equivalent domain coordinates, explicit triangle/point identities and actual native result/coverage are exposed. No synthetic pointer events or forged preview-ready acknowledgements.',
  },
] as const;
