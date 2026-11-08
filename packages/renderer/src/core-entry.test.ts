/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// This file must never import the package root: node:test runs each test file
// in its own process, so the root entry's point-cloud install stays absent.
import * as core from './core.js';
import { Renderer } from './core.js';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Relative modules a file loads at runtime: `import type` / `export type` erase. */
function valueImports(file: string): string[] {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const out: string[] = [];
    const re = /(?:^|;|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const spec = m[4] ?? m[5];
        if (m[2]) continue; // `import type { … }` / `export type { … }`
        out.push(join(dirname(file), spec.replace(/\.js$/, '.ts')));
    }
    return out;
}

/** Every source module reachable from `entry` through value imports. */
function runtimeGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
        const file = stack.pop() as string;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const dep of valueImports(file)) stack.push(dep);
    }
    return new Set([...seen].map((f) => relative(SRC, f)));
}

const POINT_CLOUD_MODULES = [
    'pointcloud/point-cloud-renderer.ts',
    'pointcloud/point-cloud-node.ts',
    'pointcloud/point-cloud-spatial-index.ts',
    'pointcloud/point-pipeline.ts',
    'pointcloud/point-shader.wgsl.ts',
    'edl-pass.ts',
    'deviation/deviation-computer.ts',
    'deviation/deviation-shader.wgsl.ts',
    'deviation/triangle-bvh.ts',
];

describe('@ifc-lite/renderer/core', () => {
    it('reaches no point-cloud renderer or deviation pipeline module at runtime', () => {
        const graph = runtimeGraph(join(SRC, 'core.ts'));
        assert.ok(graph.has('renderer.ts') && graph.has('scene.ts'), 'graph walk found the Renderer');
        assert.deepStrictEqual(POINT_CLOUD_MODULES.filter((m) => graph.has(m)), []);
        // The root entry does load them: the guard above is not vacuous.
        const full = runtimeGraph(join(SRC, 'index.ts'));
        assert.deepStrictEqual(POINT_CLOUD_MODULES.filter((m) => !full.has(m)), []);
    });

    it('publishes the root surface minus the point-cloud and deviation values', () => {
        for (const name of ['PointCloudRenderer', 'PointRenderPipeline', 'computeDeviationStatistics']) {
            assert.strictEqual(name in core, false, `${name} must not be exported by core`);
        }
        assert.strictEqual(typeof core.Renderer, 'function');
        assert.strictEqual(typeof core.Picker, 'function');
    });

    it('rejects point-cloud and deviation calls with a pointer to the root entry', async () => {
        const canvas = { width: 8, height: 8, getBoundingClientRect: () => ({ width: 8, height: 8 }) } as unknown as HTMLCanvasElement;
        const renderer = new Renderer(canvas);
        const unavailable = /not included in @ifc-lite\/renderer\/core/;
        assert.throws(() => renderer.setPointClouds([]), unavailable);
        assert.throws(() => renderer.addPointClouds([]), unavailable);
        assert.throws(() => renderer.beginPointCloudStream({ expressId: 1 }), unavailable);
        await assert.rejects(renderer.computeDeviations(), unavailable);
        await assert.rejects(renderer.readDeviationAssetStats(), unavailable);
        await assert.rejects(renderer.readDeviationDistances(), unavailable);
        assert.strictEqual(renderer.getPointCloudAssetCount(), 0);
        assert.strictEqual(renderer.getPointCloudPointCount(), 0);
        renderer.clearPointClouds();
    });
});
