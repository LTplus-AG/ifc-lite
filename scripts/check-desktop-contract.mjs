#!/usr/bin/env node

/**
 * Desktop Contract Checker
 *
 * Validates that the shared viewer's desktop integration surface is intact.
 * Run by CI (desktop-compat.yml) to catch breaking changes before they
 * reach the desktop repo.
 *
 * Checks:
 *  1. DESKTOP_CONTRACT_VERSION file exists and contains a valid integer.
 *  2. All override target modules exist (same list as the CI workflow).
 *  3. Tauri stub files exist for dynamic import aliases.
 *  4. Store exports expected by the desktop repo are present.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VIEWER = path.join(ROOT, 'apps/viewer/src');

let errors = 0;

function check(filePath, description) {
  const full = path.resolve(ROOT, filePath);
  if (!fs.existsSync(full)) {
    console.error(`FAIL: ${description}\n      Missing: ${filePath}`);
    errors++;
    return false;
  }
  return true;
}

function checkExport(filePath, exportName) {
  const full = path.resolve(ROOT, filePath);
  if (!fs.existsSync(full)) {
    console.error(`FAIL: Export check skipped — file missing: ${filePath}`);
    errors++;
    return;
  }
  const content = fs.readFileSync(full, 'utf-8');
  if (!content.includes(exportName)) {
    console.error(`FAIL: Expected export "${exportName}" not found in ${filePath}`);
    errors++;
  }
}

// 1. Contract version file
const versionFile = path.join(ROOT, 'apps/viewer/DESKTOP_CONTRACT_VERSION');
if (fs.existsSync(versionFile)) {
  const version = parseInt(fs.readFileSync(versionFile, 'utf-8').trim(), 10);
  if (Number.isNaN(version) || version < 1) {
    console.error('FAIL: DESKTOP_CONTRACT_VERSION must contain a positive integer');
    errors++;
  } else {
    console.log(`Contract version: ${version}`);
  }
} else {
  console.error('FAIL: apps/viewer/DESKTOP_CONTRACT_VERSION missing');
  errors++;
}

// 2. Override target modules — the desktop repo redirects these via path aliases
const OVERRIDE_TARGETS = [
  'apps/viewer/src/services/file-dialog.ts',
  'apps/viewer/src/services/desktop-logger.ts',
  'apps/viewer/src/services/app-navigation.ts',
  'apps/viewer/src/services/desktop-panel-actions.ts',
  'apps/viewer/src/services/analysis-extensions.ts',
  'apps/viewer/src/services/desktop-preferences.ts',
  'apps/viewer/src/services/desktop-export.ts',
  'apps/viewer/src/services/bsdd.ts',
  'apps/viewer/src/services/desktop-cache.ts',
  'apps/viewer/src/services/desktop-harness.ts',
  'apps/viewer/src/services/desktop-native-metadata.ts',
  'apps/viewer/src/lib/desktop-product.ts',
  'apps/viewer/src/lib/desktop-entitlement.ts',
  'apps/viewer/src/lib/desktop/desktopEntitlementEvents.ts',
  'apps/viewer/src/lib/recent-files.ts',
  'apps/viewer/src/hooks/useIfc.ts',
];

console.log(`\nChecking ${OVERRIDE_TARGETS.length} override targets...`);
for (const target of OVERRIDE_TARGETS) {
  check(target, `Override target: ${path.basename(target)}`);
}

// 3. Tauri stub files (used by viewer + desktop vite configs)
const TAURI_STUBS = [
  'apps/viewer/src/services/tauri-core-stub.ts',
  'apps/viewer/src/services/tauri-dialog-stub.ts',
  'apps/viewer/src/services/tauri-fs-stub.ts',
];

console.log(`\nChecking ${TAURI_STUBS.length} Tauri stubs...`);
for (const stub of TAURI_STUBS) {
  check(stub, `Tauri stub: ${path.basename(stub)}`);
}

// 4. Key exports that the desktop repo depends on
console.log('\nChecking key exports...');
checkExport('apps/viewer/src/store/index.ts', 'useViewerStore');
checkExport('apps/viewer/src/store/index.ts', 'getViewerStoreApi');
checkExport('apps/viewer/src/utils/ifcConfig.ts', 'isTauri');
checkExport('apps/viewer/src/utils/ifcConfig.ts', 'HUGE_NATIVE_FILE_THRESHOLD');

// Summary
console.log('');
if (errors > 0) {
  console.error(`${errors} check(s) failed. The desktop repo depends on these files/exports.`);
  console.error('If these changes are intentional, update the desktop repo and bump DESKTOP_CONTRACT_VERSION.');
  process.exit(1);
} else {
  console.log('All desktop contract checks passed.');
}
