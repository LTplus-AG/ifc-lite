/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate a minimal blank IFC4 model as a synthetic `File`, so the
 * welcome card's "Start blank" action can feed it through the regular
 * `loadFile()` pipeline (format detection → WASM → store federation)
 * without diverging code paths.
 *
 * The result has the smallest spatial hierarchy that satisfies the
 * Add Element panel's gating (`AddElementPanel.tsx`): one IfcProject,
 * IfcSite, IfcBuilding and a single IfcBuildingStorey at elevation 0.
 */

import { IfcCreator } from '@ifc-lite/create';

export interface BlankIfcOptions {
  projectName?: string;
  storeyName?: string;
  storeyElevation?: number;
}

export function createBlankIfcFile(options: BlankIfcOptions = {}): File {
  const {
    projectName = 'Untitled Project',
    storeyName = 'Level 1',
    storeyElevation = 0,
  } = options;

  const creator = new IfcCreator({ Name: projectName });
  creator.addIfcBuildingStorey({ Name: storeyName, Elevation: storeyElevation });
  const { content } = creator.toIfc();

  const safeName = projectName.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'untitled';
  return new File([content], `${safeName}.ifc`, { type: 'application/ifc' });
}
