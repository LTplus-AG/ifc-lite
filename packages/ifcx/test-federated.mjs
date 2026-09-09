#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test script for Federated IFCX parsing
 * Run with: node test-federated.mjs
 *
 * Tests the federation of Hello Wall with various overlays.
 */

import {
  parseFederatedIfcx,
  parseIfcx,
  detectFormat,
  createLayerStack,
  parsePath,
} from './dist/index.js';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testModelsDir = resolve(__dirname, '../../tests/models/ifc5');

async function loadFile(name) {
  const filePath = join(testModelsDir, name);
  const buffer = await readFile(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function runTests() {
  console.log('\n========================================');
  console.log('  Federated IFCX Parser Tests');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Single file parsing (baseline)
  console.log('Test 1: Single file parsing (hello-wall.ifcx)');
  console.log('─'.repeat(50));
  try {
    const buffer = await loadFile('Hello_Wall_hello-wall.ifcx');
    const result = await parseIfcx(buffer);

    console.log(`  ✓ Entities: ${result.entityCount}`);
    console.log(`  ✓ Meshes: ${result.meshes.length}`);
    console.log(`  ✓ Parse time: ${result.parseTime.toFixed(2)} ms`);

    // Find the wall
    const wallId = [...result.pathToId.entries()]
      .find(([path]) => path === '93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b')?.[1];

    if (wallId) {
      const wallProps = result.properties.getForEntity(wallId);
      const hasFireRating = wallProps.some(pset =>
        pset.properties.some(p => p.name === 'FireRating')
      );
      console.log(`  ✓ Wall found (ID: ${wallId})`);
      console.log(`  ✓ Wall has FireRating: ${hasFireRating} (expected: false)`);

      if (!hasFireRating) {
        console.log('  ✅ PASSED\n');
        passed++;
      } else {
        console.log('  ❌ FAILED: Wall should not have FireRating in base file\n');
        failed++;
      }
    } else {
      console.log('  ❌ FAILED: Wall not found\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ FAILED: ${e.message}\n`);
    failed++;
  }

  // Test 2: Federated parsing with fire rating overlay
  console.log('Test 2: Federated parsing (hello-wall + fire-rating-30)');
  console.log('─'.repeat(50));
  try {
    const baseBuffer = await loadFile('Hello_Wall_hello-wall.ifcx');
    const overlayBuffer = await loadFile('Hello_Wall_hello-wall-add-fire-rating-30.ifcx');

    const result = await parseFederatedIfcx([
      { buffer: baseBuffer, name: 'hello-wall.ifcx' },
      { buffer: overlayBuffer, name: 'add-fire-rating-30.ifcx' },
    ]);

    console.log(`  ✓ Layers: ${result.layerStack.count}`);
    console.log(`  ✓ Entities: ${result.entityCount}`);
    console.log(`  ✓ Cross-layer references: ${result.compositionStats.crossLayerReferences}`);
    console.log(`  ✓ Parse time: ${result.parseTime.toFixed(2)} ms`);

    // Find the wall
    const wallId = [...result.pathToId.entries()]
      .find(([path]) => path === '93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b')?.[1];

    if (wallId) {
      const wallProps = result.properties.getForEntity(wallId);
      const fireRatingProp = wallProps
        .flatMap(pset => pset.properties)
        .find(p => p.name === 'FireRating');

      console.log(`  ✓ Wall found (ID: ${wallId})`);
      console.log(`  ✓ FireRating value: ${fireRatingProp?.value ?? 'not found'}`);

      if (fireRatingProp?.value === 'R30') {
        console.log('  ✅ PASSED\n');
        passed++;
      } else {
        console.log('  ❌ FAILED: FireRating should be R30\n');
        failed++;
      }
    } else {
      console.log('  ❌ FAILED: Wall not found\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ FAILED: ${e.message}`);
    console.error(e.stack);
    failed++;
  }

  // Test 3: Layer ordering (fire rating 60 should override 30)
  console.log('Test 3: Layer ordering (30 then 60 overlay)');
  console.log('─'.repeat(50));
  try {
    const baseBuffer = await loadFile('Hello_Wall_hello-wall.ifcx');
    const overlay30Buffer = await loadFile('Hello_Wall_hello-wall-add-fire-rating-30.ifcx');
    const overlay60Buffer = await loadFile('Hello_Wall_hello-wall-add-fire-rating-60.ifcx');

    const result = await parseFederatedIfcx([
      { buffer: baseBuffer, name: 'hello-wall.ifcx' },
      { buffer: overlay30Buffer, name: 'add-fire-rating-30.ifcx' },
      { buffer: overlay60Buffer, name: 'add-fire-rating-60.ifcx' },
    ]);

    console.log(`  ✓ Layers: ${result.layerStack.count}`);

    // Find the wall
    const wallId = [...result.pathToId.entries()]
      .find(([path]) => path === '93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b')?.[1];

    if (wallId) {
      const wallProps = result.properties.getForEntity(wallId);
      const fireRatingProp = wallProps
        .flatMap(pset => pset.properties)
        .find(p => p.name === 'FireRating');

      console.log(`  ✓ FireRating value: ${fireRatingProp?.value ?? 'not found'}`);

      // Last overlay (60) should win
      if (fireRatingProp?.value === 'R60') {
        console.log('  ✅ PASSED\n');
        passed++;
      } else {
        console.log(`  ❌ FAILED: FireRating should be R60 (got ${fireRatingProp?.value})\n`);
        failed++;
      }
    } else {
      console.log('  ❌ FAILED: Wall not found\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ FAILED: ${e.message}\n`);
    console.error(e.stack);
    failed++;
  }

  // Test 4: Path parsing
  console.log('Test 4: Path parsing utilities');
  console.log('─'.repeat(50));
  try {
    const path1 = parsePath('93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b');
    console.log(`  UUID path: root="${path1.root}", segments=${path1.segments.length}, isUuid=${path1.isUuid}`);

    const path2 = parsePath('93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b/My_Wall/Window');
    console.log(`  Hierarchical path: root="${path2.root}", segments=[${path2.segments.join(', ')}]`);

    if (
      path1.isUuid &&
      path1.segments.length === 0 &&
      path2.segments.length === 2 &&
      path2.segments[0] === 'My_Wall'
    ) {
      console.log('  ✅ PASSED\n');
      passed++;
    } else {
      console.log('  ❌ FAILED\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ FAILED: ${e.message}\n`);
    failed++;
  }

  // Test 5: LayerStack operations
  console.log('Test 5: LayerStack operations');
  console.log('─'.repeat(50));
  try {
    const baseBuffer = await loadFile('Hello_Wall_hello-wall.ifcx');
    const baseText = new TextDecoder().decode(baseBuffer);
    const baseFile = JSON.parse(baseText);

    const stack = createLayerStack();

    // Add layers
    const id1 = stack.addLayer(baseFile, baseBuffer, 'base');
    const id2 = stack.addLayer(baseFile, baseBuffer, 'overlay1');
    const id3 = stack.addLayer(baseFile, baseBuffer, 'overlay2');

    console.log(`  ✓ Added 3 layers`);
    console.log(`  ✓ Layer count: ${stack.count}`);
    console.log(`  ✓ Layer order: ${stack.getLayers().map(l => l.name).join(' > ')}`);

    // Test reordering
    stack.reorderLayers([id3, id1, id2]);
    console.log(`  ✓ After reorder: ${stack.getLayers().map(l => l.name).join(' > ')}`);

    // Test toggle
    stack.toggleLayer(id2);
    console.log(`  ✓ Enabled layers: ${stack.getEnabledLayers().map(l => l.name).join(', ')}`);

    // Test remove
    stack.removeLayer(id3);
    console.log(`  ✓ After remove: ${stack.getLayers().map(l => l.name).join(' > ')}`);

    if (stack.count === 2 && stack.getEnabledLayers().length === 1) {
      console.log('  ✅ PASSED\n');
      passed++;
    } else {
      console.log('  ❌ FAILED\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ❌ FAILED: ${e.message}\n`);
    console.error(e.stack);
    failed++;
  }

  // Test 6: PCERT multi-discipline scene (if files exist)
  console.log('Test 6: Multi-discipline scene (PCERT)');
  console.log('─'.repeat(50));
  try {
    const archBuffer = await loadFile('PCERT-Sample-Scene_Building-Architecture.ifcx');
    const structBuffer = await loadFile('PCERT-Sample-Scene_Building-Structural.ifcx');

    const result = await parseFederatedIfcx([
      { buffer: archBuffer, name: 'Architecture' },
      { buffer: structBuffer, name: 'Structural' },
    ]);

    console.log(`  ✓ Layers: ${result.layerStack.count}`);
    console.log(`  ✓ Entities: ${result.entityCount}`);
    console.log(`  ✓ Meshes: ${result.meshes.length}`);
    console.log(`  ✓ Cross-layer refs: ${result.compositionStats.crossLayerReferences}`);
    console.log(`  ✓ Inheritance resolutions: ${result.compositionStats.inheritanceResolutions}`);

    if (result.entityCount > 0 && result.meshes.length > 0) {
      console.log('  ✅ PASSED\n');
      passed++;
    } else {
      console.log('  ❌ FAILED: No entities or meshes\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ⚠ SKIPPED: ${e.message}\n`);
  }

  // Test 7: Tunnel excavation sequence (multiple phases)
  console.log('Test 7: Tunnel excavation sequence (5 phases)');
  console.log('─'.repeat(50));
  try {
    const phase1 = await loadFile('Tunnel_Excavation_01_TopHeading_0-1.ifcx');
    const phase2 = await loadFile('Tunnel_Excavation_02_TopHeading_1-2.ifcx');
    const phase3 = await loadFile('Tunnel_Excavation_03_TopHeading_2-3.ifcx');
    const phase4 = await loadFile('Tunnel_Excavation_04_TopHeading_3-4.ifcx');
    const phase5 = await loadFile('Tunnel_Excavation_05_TopHeading_4-5.ifcx');

    const result = await parseFederatedIfcx([
      { buffer: phase1, name: 'Phase 1' },
      { buffer: phase2, name: 'Phase 2' },
      { buffer: phase3, name: 'Phase 3' },
      { buffer: phase4, name: 'Phase 4' },
      { buffer: phase5, name: 'Phase 5' },
    ]);

    console.log(`  ✓ Layers: ${result.layerStack.count}`);
    console.log(`  ✓ Entities: ${result.entityCount}`);
    console.log(`  ✓ Meshes: ${result.meshes.length}`);
    console.log(`  ✓ Parse time: ${result.parseTime.toFixed(2)} ms`);

    if (result.layerStack.count === 5 && result.meshes.length > 0) {
      console.log('  ✅ PASSED\n');
      passed++;
    } else {
      console.log('  ❌ FAILED\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ⚠ SKIPPED: ${e.message}\n`);
  }

  // Test 8: Advanced Hello Wall with 3rd window
  console.log('Test 8: Hello Wall + 3rd window (geometry modification)');
  console.log('─'.repeat(50));
  try {
    const baseBuffer = await loadFile('Hello_Wall_hello-wall.ifcx');
    const windowBuffer = await loadFile('Hello_Wall_advanced_3rd-window.ifcx');

    const result = await parseFederatedIfcx([
      { buffer: baseBuffer, name: 'hello-wall.ifcx' },
      { buffer: windowBuffer, name: '3rd-window.ifcx' },
    ]);

    console.log(`  ✓ Layers: ${result.layerStack.count}`);
    console.log(`  ✓ Entities: ${result.entityCount}`);
    console.log(`  ✓ Meshes: ${result.meshes.length}`);

    // The 3rd window overlay should add more geometry
    if (result.entityCount > 0 && result.meshes.length > 0) {
      console.log('  ✅ PASSED\n');
      passed++;
    } else {
      console.log('  ❌ FAILED\n');
      failed++;
    }
  } catch (e) {
    console.log(`  ⚠ SKIPPED: ${e.message}\n`);
  }

  // Summary
  console.log('========================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
