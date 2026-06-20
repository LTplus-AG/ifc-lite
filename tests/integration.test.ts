/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for IFC-Lite remaining features
 *
 * Tests:
 * 1. Quantity extraction
 * 2. SQL integration (DuckDB)
 * 3. Parquet export
 * 4. CSV export
 * 5. JSON-LD export
 *
 * Run with: npx tsx tests/integration.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test result tracking
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const results: TestResult[] = [];

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return (async () => {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, duration: Date.now() - start });
      console.log(`✅ ${name}`);
    } catch (error: any) {
      results.push({ name, passed: false, error: error.message, duration: Date.now() - start });
      console.log(`❌ ${name}: ${error.message}`);
    }
  })();
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertGreaterThan(actual: number, expected: number, message: string): void {
  if (actual <= expected) {
    throw new Error(`${message}: expected > ${expected}, got ${actual}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════

async function runTests() {
  console.log('\n🧪 IFC-Lite Integration Tests\n');
  console.log('═'.repeat(60));

  // Find an IFC file with quantities
  const ifcFiles = [
    path.join(__dirname, 'models', 'various', '01_BIMcollab_Example_ARC.ifc'),
    path.join(__dirname, 'models', 'various', 'test.ifc'),
  ];

  let testFile: string | null = null;
  for (const file of ifcFiles) {
    if (fs.existsSync(file)) {
      testFile = file;
      break;
    }
  }

  if (!testFile) {
    console.log('⚠️  No IFC test file found. Skipping integration tests.');
    return;
  }

  console.log(`\n📁 Using test file: ${path.basename(testFile)}\n`);

  // Load required modules
  const { IfcParser } = await import('../packages/parser/src/index.js');
  const { QuantityExtractor } = await import('../packages/parser/src/quantity-extractor.js');
  // CSV and JSON-LD export moved to Rust (ifc-lite-export); the TS exporters
  // were retired. Their output is covered by the crate's own tests
  // (rust/export/src/{csv,jsonld}.rs) and exercised via GeometryProcessor.

  // Parse the IFC file
  console.log('\n📖 Parsing IFC file...');
  const buffer = fs.readFileSync(testFile);
  const parser = new IfcParser();
  const store = await parser.parseColumnar(buffer.buffer);

  console.log(`   Entities: ${store.entities.count}`);
  console.log(`   Properties: ${store.properties.count}`);
  console.log(`   Quantities: ${store.quantities.count}`);
  console.log(`   Relationships: ${store.relationships.forward.edgeTargets.length}`);

  // ═══════════════════════════════════════════════════════════════
  // QUANTITY EXTRACTION TESTS
  // ═══════════════════════════════════════════════════════════════

  console.log('\n📊 Quantity Extraction Tests');
  console.log('─'.repeat(40));

  await test('QuantityTable has expected structure', () => {
    assert(store.quantities !== undefined, 'QuantityTable should exist');
    assert(typeof store.quantities.count === 'number', 'count should be number');
    assert(store.quantities.entityId instanceof Uint32Array, 'entityId should be Uint32Array');
    assert(store.quantities.qsetName instanceof Uint32Array, 'qsetName should be Uint32Array');
    assert(store.quantities.quantityName instanceof Uint32Array, 'quantityName should be Uint32Array');
    assert(store.quantities.value instanceof Float64Array, 'value should be Float64Array');
  });

  await test('QuantityTable.getForEntity returns valid structure', () => {
    // Get first entity with quantities
    const entityId = store.quantities.entityId[0];
    if (entityId) {
      const qsets = store.quantities.getForEntity(entityId);
      assert(Array.isArray(qsets), 'getForEntity should return array');
      if (qsets.length > 0) {
        assert(typeof qsets[0].name === 'string', 'qset should have name');
        assert(Array.isArray(qsets[0].quantities), 'qset should have quantities array');
      }
    }
  });

  await test('QuantityTable.getQuantityValue works', () => {
    // Try to get a quantity value
    const entityId = store.quantities.entityId[0];
    if (entityId && store.quantities.count > 0) {
      const qsets = store.quantities.getForEntity(entityId);
      if (qsets.length > 0 && qsets[0].quantities.length > 0) {
        const qsetName = qsets[0].name;
        const quantName = qsets[0].quantities[0].name;
        const value = store.quantities.getQuantityValue(entityId, qsetName, quantName);
        assert(value === null || typeof value === 'number', 'getQuantityValue should return number or null');
      }
    }
  });

  await test('QuantityTable.sumByType aggregates correctly', () => {
    // Get sum of a common quantity
    const sum = store.quantities.sumByType('Width');
    assert(typeof sum === 'number', 'sumByType should return number');
    // Sum should be >= 0
    assert(sum >= 0, 'Sum should be non-negative');
  });

  // ═══════════════════════════════════════════════════════════════
  // PARQUET EXPORT TESTS (if dependencies available)
  // ═══════════════════════════════════════════════════════════════

  console.log('\n📦 Parquet Export Tests');
  console.log('─'.repeat(40));

  await test('ParquetExporter structure is valid', async () => {
    const { ParquetExporter } = await import('../packages/export/src/parquet-exporter.js');
    const exporter = new ParquetExporter(store);

    assert(typeof exporter.exportBOS === 'function', 'exportBOS should be a function');
    assert(typeof exporter.exportTable === 'function', 'exportTable should be a function');
  });

  // Note: Full Parquet export test requires apache-arrow and parquet-wasm
  // which may not be available in all environments
  await test('ParquetExporter.exportBOS attempts export (may fail without deps)', async () => {
    const { ParquetExporter } = await import('../packages/export/src/parquet-exporter.js');
    const exporter = new ParquetExporter(store);

    try {
      const bosData = await exporter.exportBOS({ includeGeometry: false });
      assert(bosData instanceof Uint8Array, 'BOS data should be Uint8Array');
      assertGreaterThan(bosData.length, 0, 'BOS data should not be empty');
      console.log(`   BOS archive size: ${(bosData.length / 1024).toFixed(2)} KB`);
    } catch (error: any) {
      // Expected to fail if dependencies aren't installed
      if (error.message.includes('apache-arrow') || error.message.includes('parquet-wasm')) {
        console.log('   ⚠️  Skipped: parquet dependencies not installed');
      } else {
        throw error;
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // SQL INTEGRATION TESTS
  // ═══════════════════════════════════════════════════════════════

  console.log('\n🗃️  SQL Integration Tests');
  console.log('─'.repeat(40));

  await test('DuckDBIntegration.isAvailable returns boolean', async () => {
    const { DuckDBIntegration } = await import('../packages/query/src/duckdb-integration.js');
    const available = await DuckDBIntegration.isAvailable();
    assert(typeof available === 'boolean', 'isAvailable should return boolean');
    console.log(`   DuckDB available: ${available}`);
  });

  await test('DuckDBIntegration structure is valid', async () => {
    const { DuckDBIntegration } = await import('../packages/query/src/duckdb-integration.js');
    const db = new DuckDBIntegration();

    assert(typeof db.init === 'function', 'init should be a function');
    assert(typeof db.query === 'function', 'query should be a function');
    assert(typeof db.dispose === 'function', 'dispose should be a function');
  });

  // Note: Full DuckDB test requires @duckdb/duckdb-wasm
  await test('DuckDBIntegration initializes (may fail without deps)', async () => {
    const { DuckDBIntegration } = await import('../packages/query/src/duckdb-integration.js');

    const available = await DuckDBIntegration.isAvailable();
    if (!available) {
      console.log('   ⚠️  Skipped: DuckDB not available');
      return;
    }

    const db = new DuckDBIntegration();
    try {
      await db.init(store);

      // Try a simple query
      const result = await db.query('SELECT COUNT(*) as cnt FROM entities');
      assert(result.columns.includes('cnt'), 'Result should have cnt column');
      console.log(`   Entity count from SQL: ${result.rows[0]}`);

      await db.dispose();
    } catch (error: any) {
      if (error.message.includes('duckdb')) {
        console.log('   ⚠️  Skipped: DuckDB initialization failed');
      } else {
        throw error;
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════

  console.log('\n' + '═'.repeat(60));
  console.log('📊 Test Summary');
  console.log('─'.repeat(40));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`   Total:  ${results.length}`);
  console.log(`   Passed: ${passed}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Time:   ${totalDuration}ms`);

  if (failed > 0) {
    console.log('\n❌ Failed tests:');
    for (const result of results.filter(r => !r.passed)) {
      console.log(`   - ${result.name}: ${result.error}`);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    // Exit explicitly: the parquet-wasm / DuckDB availability probes can
    // leave handles (workers/wasm threads) on the event loop in CI, which
    // kept this script alive until the job timeout killed it.
    process.exit(0);
  }
}

// Run tests
runTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
