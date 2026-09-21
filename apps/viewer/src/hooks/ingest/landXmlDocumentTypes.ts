/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface LandXmlPipeMeasure { value: number; unit: string; meters: number }
export interface LandXmlPipePosition { northing: number; easting: number; northingMeters: number; eastingMeters: number; elevation: LandXmlPipeMeasure | null }
export interface LandXmlPipeUnits { linearUnit: string; elevationUnit: string; diameterUnit: string; widthUnit: string; heightUnit: string; flowUnit: string | null; linearScaleToMeters: number; elevationScaleToMeters: number; diameterScaleToMeters: number; widthScaleToMeters: number; heightScaleToMeters: number }
export interface LandXmlPipeFlow { sourceId: string; sourcePath: string; unit: string | null; flowIn: number | null; lossIn: number | null; lossOut: number | null; properties: Record<string, string> }
export interface LandXmlPipeInvert { sourceId: string; sourcePath: string; pipeSourceId: string; flowDirection: string; elevation: LandXmlPipeMeasure; properties: Record<string, string> }
export interface LandXmlPipePart { kind: 'circular' | 'elliptical' | 'egg' | 'rectangular'; properties: Record<string, string>; diameter?: LandXmlPipeMeasure; span?: LandXmlPipeMeasure; width?: LandXmlPipeMeasure; height?: LandXmlPipeMeasure; thickness?: LandXmlPipeMeasure; material: string | null }
export interface LandXmlStructurePart { kind: 'circular' | 'rectangular' | 'inlet' | 'outlet' | 'connection'; properties: Record<string, string>; diameter?: LandXmlPipeMeasure; length?: LandXmlPipeMeasure; width?: LandXmlPipeMeasure; thickness?: LandXmlPipeMeasure; material: string | null }
export interface LandXmlPipe {
  sourceId: string; sourcePath: string; name: string; properties: Record<string, string>;
  units: LandXmlPipeUnits; connectivity: { startStructureSourceId: string; endStructureSourceId: string };
  part: LandXmlPipePart; geometry: { kind: 'straight' | 'pass_through'; point: LandXmlPipePosition | null }; length: LandXmlPipeMeasure | null; flow: LandXmlPipeFlow | null;
}
export interface LandXmlPipeStructure { sourceId: string; sourcePath: string; name: string; properties: Record<string, string>; units: LandXmlPipeUnits; center: LandXmlPipePosition; part: LandXmlStructurePart; rimElevation: LandXmlPipeMeasure | null; sumpElevation: LandXmlPipeMeasure | null; inverts: LandXmlPipeInvert[]; flow: LandXmlPipeFlow | null }
export interface LandXmlPipeFeature { sourceId: string; sourcePath: string; ownerSourceId: string; properties: Record<string, string> }
export interface LandXmlPipeNetwork { sourceId: string; sourcePath: string; name: string; pipeNetworkType: string; properties: Record<string, string>; structureUnits: LandXmlPipeUnits | null; pipeUnits: LandXmlPipeUnits | null; structures: LandXmlPipeStructure[]; pipes: LandXmlPipe[]; features: LandXmlPipeFeature[] }
export interface LandXmlPipeNetworkCollection { sourceId: string; sourcePath: string; properties: Record<string, string> }
export interface LandXmlPipeNetworkDocument { version: string; rootUnits: LandXmlPipeUnits | null; collections: LandXmlPipeNetworkCollection[]; networks: LandXmlPipeNetwork[]; features: LandXmlPipeFeature[]; refusals: Array<{ sourceId: string; sourcePath: string; code: string; message: string }> }

export interface LandXmlMeshProvenance {
  meshExpressId: number;
  surfaceSourceId: string;
  renderedFaceSourceIds: string[];
  pipeSourceId?: string;
}

export interface LandXmlSurfaceCounts {
  surfaceSourceId: string;
  sourcePoints: number;
  sourceFaces: number;
  hiddenFaces: number;
  renderedFaces: number;
  droppedDegenerateFaces: number;
  droppedPrecisionFaces: number;
  droppedReframeFaces: number;
}
