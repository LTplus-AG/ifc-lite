/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/renderer/core`: the same `Renderer` and mesh, picking, section,
 * overlay and camera surface as the package root, without point-cloud
 * rendering or BIM ↔ scan deviation. Nothing here installs the point-cloud
 * factories (`point-cloud-support.ts`), so a bundler drops their pipelines
 * and shaders. On a Renderer from this entry `setPointClouds`,
 * `addPointClouds`, `beginPointCloudStream` and `computeDeviations` (and
 * its readers) throw; the point-cloud getters report zero. Importing the
 * root entry anywhere in the same program installs the factories for every
 * Renderer.
 */

export * from './renderer.js';
