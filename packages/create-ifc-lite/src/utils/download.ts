/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { rmSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

const REPO_URL = 'https://github.com/LTplus-AG/ifc-lite';
const VIEWER_PATH = 'apps/viewer';

/**
 * Run a shell command silently.  Returns true on success, false on failure.
 */
function runCommand(cmd: string, cwd?: string): boolean {
  try {
    execSync(cmd, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download the viewer application from the ifc-lite GitHub repository.
 *
 * Tries `npx degit` first (fastest path).  Falls back to a git sparse
 * checkout when degit is unavailable or fails.
 */
export async function downloadViewer(targetDir: string, _projectName: string): Promise<boolean> {
  // Try degit first (fastest)
  if (runCommand('npx --version')) {
    console.log('  Downloading viewer template...');
    try {
      execSync(`npx degit ${REPO_URL}/${VIEWER_PATH} "${targetDir}"`, {
        stdio: 'pipe',
        timeout: 60000
      });
      return true;
    } catch {
      // degit failed, try git sparse checkout
    }
  }

  // Fallback: git sparse checkout
  if (runCommand('git --version')) {
    console.log('  Downloading via git...');
    const tempDir = join(dirname(targetDir), `.temp-${Date.now()}`);
    try {
      execSync(`git clone --filter=blob:none --sparse "${REPO_URL}.git" "${tempDir}"`, {
        stdio: 'pipe',
        timeout: 120000
      });
      execSync(`git sparse-checkout set ${VIEWER_PATH}`, { cwd: tempDir, stdio: 'pipe' });

      // Move viewer to target
      const viewerSrc = join(tempDir, VIEWER_PATH);
      execSync(`mv "${viewerSrc}" "${targetDir}"`, { stdio: 'pipe' });
      rmSync(tempDir, { recursive: true, force: true });
      return true;
    } catch {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return false;
}
