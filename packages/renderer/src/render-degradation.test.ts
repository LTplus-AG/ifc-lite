/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "degrading and not recovering" threshold policy (issue #2417).
 *
 * `Renderer.render()` refuses to latch on a throw that is not a device-loss
 * signal, because host memory pressure on a live device must cost one frame and
 * not the session. The cost of that (correct) choice is that a failure which
 * never clears is indistinguishable from one that did. This is the policy that
 * closes that blind spot, tested apart from the renderer so the threshold and
 * its once-per-session latch are pinned on their own.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    PERSISTENT_DEGRADATION_FRAMES,
    RenderDegradationMonitor,
} from './render-degradation.js';

const DETAIL = 'createBuffer failed, size (193836) is too large';

describe('RenderDegradationMonitor', () => {
    it('stays silent below the threshold', () => {
        const monitor = new RenderDegradationMonitor();
        for (let frames = 1; frames < PERSISTENT_DEGRADATION_FRAMES; frames++) {
            assert.equal(
                monitor.note(frames, DETAIL, 'frame'),
                null,
                `frame ${frames} is still inside the transient budget`,
            );
        }
    });

    it('reports exactly on the crossing frame, carrying count, detail and origin', () => {
        const monitor = new RenderDegradationMonitor();
        for (let frames = 1; frames < PERSISTENT_DEGRADATION_FRAMES; frames++) {
            monitor.note(frames, DETAIL, 'frame');
        }
        const info = monitor.note(PERSISTENT_DEGRADATION_FRAMES, DETAIL, 'encode');
        assert.notEqual(info, null, 'the crossing frame must report');
        assert.equal(info!.degradedFrames, PERSISTENT_DEGRADATION_FRAMES);
        assert.equal(info!.detail, DETAIL);
        assert.equal(info!.origin, 'encode');
    });

    it('latches: every later frame is silent, however bad it gets', () => {
        // The renderer fans this out to a toast and a captured exception. One
        // wedged viewport is one report; a report per rAF would be a self-DDoS
        // of error tracking and an unusable UI.
        const monitor = new RenderDegradationMonitor();
        let reports = 0;
        for (let frames = 1; frames <= PERSISTENT_DEGRADATION_FRAMES * 10; frames++) {
            if (monitor.note(frames, DETAIL, 'frame')) reports++;
        }
        assert.equal(reports, 1);
    });

    it('reports on the first count that is already past the threshold', () => {
        // The renderer's counter also advances on frames this monitor never
        // sees (a device-loss throw is counted before it latches), so the
        // crossing value is not guaranteed to be the threshold exactly. A `===`
        // test would then never fire at all.
        const monitor = new RenderDegradationMonitor();
        const info = monitor.note(PERSISTENT_DEGRADATION_FRAMES + 7, DETAIL, 'frame');
        assert.notEqual(info, null, 'the comparison must be >=, not ===');
        assert.equal(info!.degradedFrames, PERSISTENT_DEGRADATION_FRAMES + 7);
    });

    it('holds no counter of its own — two monitors do not share state', () => {
        // The count belongs to the renderer (`getDiagnostics().errors`); a
        // second copy here would be a second truth that can drift.
        const a = new RenderDegradationMonitor();
        const b = new RenderDegradationMonitor();
        assert.notEqual(a.note(PERSISTENT_DEGRADATION_FRAMES, DETAIL, 'frame'), null);
        assert.notEqual(b.note(PERSISTENT_DEGRADATION_FRAMES, DETAIL, 'frame'), null);
        assert.equal(a.note(PERSISTENT_DEGRADATION_FRAMES + 1, DETAIL, 'frame'), null);
    });

    it('sets a threshold that a single failure episode cannot reach', () => {
        // The renderer re-requests at most MAX_DEGRADED_SELF_RETRIES (3) frames
        // after a failure and then goes quiet, so one episode costs at most four
        // degraded frames. A threshold at or below that would fire on the first
        // transient host-memory spike — the exact false positive the
        // non-latching branch exists to avoid.
        const MAX_FRAMES_PER_EPISODE = 4;
        assert.ok(
            PERSISTENT_DEGRADATION_FRAMES > MAX_FRAMES_PER_EPISODE,
            'the threshold must require more than one failure episode',
        );
    });
});
