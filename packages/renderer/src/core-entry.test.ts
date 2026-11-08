/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, relative } from 'node:path';

// node:test runs each file in its own process, so nothing here has loaded the
// root entry (and its point-cloud install) before `before()` imports core.
// A resolve hook records every module the runtime actually loads: the
// behaviour a bundler's tree-shaking starts from, with `import type` erased.
const SRC = dirname(fileURLToPath(import.meta.url));
const loaded = new Set<string>();
const sentinels = new Map<string, () => void>();
const { port1, port2 } = new MessageChannel();
port1.on('message', (url: string) => {
    loaded.add(url);
    sentinels.get(url)?.();
});
port1.unref();
register(
    'data:text/javascript,' + encodeURIComponent(
        'let port; export function initialize(d) { port = d.port; }'
        + ' export async function resolve(s, c, next) { const r = await next(s, c); port.postMessage(r.url); return r; }',
    ),
    { data: { port: port2 }, transferList: [port2] },
);

/** Import `specifier`, then wait until every resolve it caused has been reported. */
async function importAndSettle<T>(specifier: string): Promise<T> {
    const mod = await import(specifier) as T;
    // Messages arrive in order: once a later import's URL is seen, so are all of these.
    const sentinel = `data:text/javascript,export default ${Date.now()}${Math.random()}`.replace('.', '');
    const seen = new Promise<void>((resolve) => sentinels.set(sentinel, resolve));
    await import(sentinel);
    await seen;
    return mod;
}

function loadedSources(): Set<string> {
    return new Set([...loaded].filter((u) => u.startsWith('file:')).map((u) => relative(SRC, fileURLToPath(u))));
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

type CoreModule = typeof import('./core.js');
let core: CoreModule;

describe('@ifc-lite/renderer/core', () => {
    before(async () => { core = await importAndSettle<CoreModule>('./core.js'); });

    it('loads no point-cloud renderer, point pipeline, EDL or deviation module', () => {
        const sources = loadedSources();
        assert.ok(sources.has('renderer.ts') && sources.has('scene.ts'), 'the hook saw the Renderer load');
        assert.deepStrictEqual(POINT_CLOUD_MODULES.filter((m) => sources.has(m)), []);
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
        const renderer = new core.Renderer(canvas);
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

    // Last: importing the root installs point-cloud support for this process.
    it('the root entry does load them, so the check above is not vacuous', async () => {
        const root = await importAndSettle<typeof import('./index.js')>('./index.js');
        const sources = loadedSources();
        assert.deepStrictEqual(POINT_CLOUD_MODULES.filter((m) => !sources.has(m)), []);
        assert.strictEqual(root.Renderer, core.Renderer, 'both entries publish one Renderer class');
        const renderer = new root.Renderer({ width: 8, height: 8, getBoundingClientRect: () => ({ width: 8, height: 8 }) } as unknown as HTMLCanvasElement);
        assert.throws(() => renderer.setPointClouds([]), /Renderer not initialized/);
    });
});
