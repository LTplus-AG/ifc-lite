/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Import for its effect, after `setup-dom`: the Section tool loads on first use (#7616), so a test
 * that mounts it through `ToolOverlays` and asserts synchronously loads the chunks first. Through
 * the registry's namespace, so a tree where the tool is not lazy (nothing to wait for) still loads this file.
 */

import * as registry from '@/lib/viewport-ui/tool-hud-registry';

await (registry as { loadSectionTool?: () => Promise<void> }).loadSectionTool?.();
