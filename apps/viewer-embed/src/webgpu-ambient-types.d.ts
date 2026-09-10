/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * apps/viewer-embed typechecks packages/renderer/src/**\/*.ts directly (via
 * the `@ifc-lite/renderer` path mapping in tsconfig.json), using this
 * project's own compiler options rather than the renderer package's. The
 * renderer's own tsconfig sets `"types": ["@webgpu/types"]`, but that
 * setting is not visible to this project, so the renderer's
 * GPUShaderStage/GPUTextureUsage/GPUColorWrite/GPUMapMode bit-flag globals
 * (declared only by @webgpu/types, not by lib.dom.d.ts) go undeclared here
 * without an explicit reference.
 */
/// <reference types="@webgpu/types" />
