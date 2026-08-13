#!/usr/bin/env node
/**
 * Test script for IFCX parsing
 * Run with: node test-parse.mjs <ifcx-file>
 */

import { parseIfcx, detectFormat } from './dist/index.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const file = process.argv[2] || '/tmp/ifc5-dev/examples/Hello Wall/hello-wall.ifcx';
const filePath = resolve(file);

console.log(`\n=== IFCX Parser Test ===`);
console.log(`File: ${filePath}\n`);

try {
  const buffer = await readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

  // Detect format
  const format = detectFormat(arrayBuffer);
  console.log(`Detected format: ${format}`);

  if (format !== 'ifcx') {
    console.error('Not an IFCX file!');
    process.exit(1);
  }

  // Parse
  console.log('\nParsing...');
  const result = await parseIfcx(arrayBuffer, {
    onProgress: ({ phase, percent }) => {
      if (percent === 100) {
        console.log(`  ${phase}: done`);
      }
    }
  });

  console.log('\n=== Parse Results ===');
  console.log(`Schema version: ${result.schemaVersion}`);
  console.log(`File size: ${result.fileSize} bytes`);
  console.log(`Parse time: ${result.parseTime.toFixed(2)} ms`);
  console.log(`Entities: ${result.entityCount}`);
  console.log(`Meshes: ${result.meshes.length}`);

  // Show entities
  console.log('\n=== Entities ===');
  const entities = result.entities;
  for (let i = 0; i < Math.min(entities.count, 10); i++) {
    const id = entities.expressId[i];
    const name = result.strings.get(entities.name[i]);
    const typeName = entities.getTypeName(id);
    console.log(`  #${id}: ${typeName} - "${name}"`);
  }
  if (entities.count > 10) {
    console.log(`  ... and ${entities.count - 10} more`);
  }

  // Show meshes
  console.log('\n=== Geometry ===');
  let totalTriangles = 0;
  let totalVertices = 0;
  for (const mesh of result.meshes) {
    totalTriangles += mesh.indices.length / 3;
    totalVertices += mesh.positions.length / 3;
  }
  console.log(`  Total meshes: ${result.meshes.length}`);
  console.log(`  Total triangles: ${totalTriangles}`);
  console.log(`  Total vertices: ${totalVertices}`);

  // Show first mesh details
  if (result.meshes.length > 0) {
    const mesh = result.meshes[0];
    console.log(`\n  First mesh:`);
    console.log(`    Express ID: ${mesh.expressId}`);
    console.log(`    IFC Type: ${mesh.ifcType || 'N/A'}`);
    console.log(`    Triangles: ${mesh.indices.length / 3}`);
    console.log(`    Vertices: ${mesh.positions.length / 3}`);
    console.log(`    Color: [${mesh.color.join(', ')}]`);
  }

  // Show spatial hierarchy
  console.log('\n=== Spatial Hierarchy ===');
  const hierarchy = result.spatialHierarchy;
  // eslint-disable-next-line no-inner-declarations -- a hand-run scratch script
  function printNode(node, indent = 0) {
    const prefix = '  '.repeat(indent);
    console.log(`${prefix}- ${node.name} (${node.type === 1 ? 'Project' : node.type === 2 ? 'Site' : node.type === 3 ? 'Building' : node.type === 4 ? 'Storey' : node.type === 5 ? 'Space' : 'Element'})`);
    if (node.elements.length > 0) {
      console.log(`${prefix}  Elements: ${node.elements.length}`);
    }
    for (const child of node.children) {
      printNode(child, indent + 1);
    }
  }
  printNode(hierarchy.project);

  // Show properties
  console.log('\n=== Sample Properties ===');
  const props = result.properties;
  console.log(`  Total property rows: ${props.count}`);
  if (props.count > 0) {
    // Find entity with most properties
    const entityPropCounts = new Map();
    for (let i = 0; i < props.count; i++) {
      const eid = props.entityId[i];
      entityPropCounts.set(eid, (entityPropCounts.get(eid) || 0) + 1);
    }
    const [richestEntity] = [...entityPropCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];

    if (richestEntity) {
      const psets = props.getForEntity(richestEntity);
      console.log(`  Properties for entity #${richestEntity} (${entityPropCounts.get(richestEntity)} properties):`);
      for (const pset of psets) {
        console.log(`    ${pset.name}:`);
        for (const prop of pset.properties) {
          console.log(`      ${prop.name}: ${prop.value} (type: ${prop.type})`);
        }
      }
    }
  } else {
    console.log('  No properties found');
  }

  // Show quantities
  console.log('\n=== Sample Quantities ===');
  const quants = result.quantities;
  console.log(`  Total quantity rows: ${quants.count}`);
  if (quants.count > 0) {
    // Find entity with quantities
    const entityQuantCounts = new Map();
    for (let i = 0; i < quants.count; i++) {
      const eid = quants.entityId[i];
      entityQuantCounts.set(eid, (entityQuantCounts.get(eid) || 0) + 1);
    }
    const [richestEntity] = [...entityQuantCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];

    if (richestEntity) {
      const qsets = quants.getForEntity(richestEntity);
      console.log(`  Quantities for entity #${richestEntity} (${entityQuantCounts.get(richestEntity)} quantities):`);
      for (const qset of qsets) {
        console.log(`    ${qset.name}:`);
        for (const q of qset.quantities) {
          const typeNames = ['Length', 'Area', 'Volume', 'Count', 'Weight', 'Time'];
          console.log(`      ${q.name}: ${q.value} (type: ${typeNames[q.type] || q.type})`);
        }
      }
    }
  } else {
    console.log('  No quantities found');
  }

  console.log('\n=== Test Passed! ===\n');

} catch (error) {
  console.error('Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
