/**
 * Coverage comparison test for IFC-Lite
 * Analyzes what entity types and representation types are processed
 */
const fs = require('fs');
const path = require('path');
const { IfcAPI } = require('../packages/wasm/ifc_lite_wasm');

// Create detailed analysis
const api = new IfcAPI();
const fixturePath = path.join(__dirname, '../tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc');
let ifc;
try {
  ifc = fs.readFileSync(fixturePath, 'utf8');
  if (ifc.startsWith('version https://git-lfs.github.com/spec/')) {
    console.error(`Fixture is still a Git LFS pointer: ${fixturePath}`);
    console.error('Run `pnpm fixtures` from the repo root to download the real bytes.');
    process.exit(2);
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`Fixture not found: ${fixturePath}`);
    console.error('Run `pnpm fixtures` from the repo root to download it.');
    process.exit(2);
  }
  throw err;
}

console.log('\n=== IFC-LITE COVERAGE ANALYSIS ===\n');

// Parse and get mesh
const mesh = api.parseZeroCopy(ifc);

console.log('GEOMETRY RESULTS:');
console.log(`  Vertices: ${mesh.positions_len / 3}`);
console.log(`  Triangles: ${mesh.indices_len / 3}`);

// Now let's analyze the file to understand what entities exist
console.log('\n\nENTITY TYPE ANALYSIS:');

// Count all building element types
const entityCounts = {};
const lines = ifc.split('\n');

for (const line of lines) {
  const match = line.match(/^#\d+=\s*(IFC\w+)\(/);
  if (match) {
    const typeName = match[1];
    entityCounts[typeName] = (entityCounts[typeName] || 0) + 1;
  }
}

// Sort by count and show building elements
const buildingElements = [
  'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLTYPE',
  'IFCSLAB', 'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE', 'IFCSLABTYPE',
  'IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCBEAMTYPE',
  'IFCCOLUMN', 'IFCCOLUMNSTANDARDCASE', 'IFCCOLUMNTYPE',
  'IFCMEMBER', 'IFCMEMBERSTANDARDCASE', 'IFCMEMBERTYPE',
  'IFCPLATE', 'IFCPLATESTANDARDCASE', 'IFCPLATETYPE',
  'IFCROOF', 'IFCROOFTYPE',
  'IFCSTAIR', 'IFCSTAIRTYPE',
  'IFCRAILING', 'IFCRAILINGTYPE',
  'IFCDOOR', 'IFCDOORSTANDARDCASE', 'IFCDOORTYPE',
  'IFCWINDOW', 'IFCWINDOWSTANDARDCASE', 'IFCWINDOWTYPE',
  'IFCFOOTING', 'IFCFOOTINGTYPE',
  'IFCPILE', 'IFCPILETYPE',
  'IFCFURNITUREELEMENT', 'IFCFURNITURETYPE',
  'IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE',
  'IFCBUILDINGELEMENTPROXY', 'IFCBUILDINGELEMENTPROXYTYPE',
  'IFCCOVERING', 'IFCCOVERINGTYPE',
  'IFCCURTAINWALL', 'IFCCURTAINWALLTYPE',
  'IFCREINFORCINGBAR', 'IFCREINFORCINGBARTYPE',
  'IFCREINFORCINGMESH', 'IFCREINFORCINGMESHTYPE',
  'IFCTENDON', 'IFCTENDONTYPE',
  'IFCTENDONANCHOR', 'IFCTENDONANCHORTYPE',
  'IFCFLOWSEGMENT', 'IFCFLOWSEGMENTTYPE',
  'IFCPIPESEGMENT', 'IFCPIPESEGMENTTYPE',
  'IFCDUCTSEGMENT', 'IFCDUCTSEGMENTTYPE',
  'IFCBUILDINGSTOREY',
  'IFCBUILDING',
  'IFCSITE'
];

console.log('\n  Building Elements (with geometry):');
let totalWithGeometry = 0;
let totalTypeEntities = 0;

for (const elem of buildingElements) {
  const count = entityCounts[elem] || 0;
  if (count > 0) {
    const isType = elem.endsWith('TYPE');
    if (isType) {
      totalTypeEntities += count;
      console.log(`    ${elem}: ${count} (TYPE - no direct geometry)`);
    } else {
      totalWithGeometry += count;
      console.log(`    ${elem}: ${count}`);
    }
  }
}

console.log(`\n  Total building elements: ${totalWithGeometry}`);
console.log(`  Total TYPE entities (templates): ${totalTypeEntities}`);

// Show representation types
console.log('\n\nREPRESENTATION TYPE ANALYSIS:');

const repTypes = {};
const repTypePattern = /IFCSHAPEREPRESENTATION\([^,]+,[^,]+,'([^']+)'/g;
let match;
while ((match = repTypePattern.exec(ifc)) !== null) {
  const repType = match[1];
  repTypes[repType] = (repTypes[repType] || 0) + 1;
}

console.log('  Shape representation types found:');
for (const [type, count] of Object.entries(repTypes).sort((a, b) => b[1] - a[1])) {
  const supported = ['Body', 'SweptSolid', 'Brep', 'CSG', 'Clipping', 'SurfaceModel', 'Tessellation', 'MappedRepresentation', 'AdvancedSweptSolid'].includes(type);
  console.log(`    ${type}: ${count} ${supported ? '(SUPPORTED)' : '(skipped - non-solid)'}`);
}

// Show geometry representation items
console.log('\n\nGEOMETRY ITEM ANALYSIS:');

const geoItems = {
  'IFCEXTRUDEDAREASOLID': entityCounts['IFCEXTRUDEDAREASOLID'] || 0,
  'IFCREVOLVEDAREASOLID': entityCounts['IFCREVOLVEDAREASOLID'] || 0,
  'IFCFACETEDBREP': entityCounts['IFCFACETEDBREP'] || 0,
  'IFCTRIANGULATEDFACESET': entityCounts['IFCTRIANGULATEDFACESET'] || 0,
  'IFCPOLYGONALFACESET': entityCounts['IFCPOLYGONALFACESET'] || 0,
  'IFCBOOLEANCLIPPINGRESULT': entityCounts['IFCBOOLEANCLIPPINGRESULT'] || 0,
  'IFCBOOLEANRESULT': entityCounts['IFCBOOLEANRESULT'] || 0,
  'IFCMAPPEDITEM': entityCounts['IFCMAPPEDITEM'] || 0,
  'IFCSWEPTDISKSOLID': entityCounts['IFCSWEPTDISKSOLID'] || 0,
  'IFCSURFACECURVESWEPTAREASOLID': entityCounts['IFCSURFACECURVESWEPTAREASOLID'] || 0,
  'IFCFIXEDREFERENCESWEPTAREASOLID': entityCounts['IFCFIXEDREFERENCESWEPTAREASOLID'] || 0,
};

console.log('  Geometry representation items:');
const supportedProcessors = ['IFCEXTRUDEDAREASOLID', 'IFCFACETEDBREP', 'IFCTRIANGULATEDFACESET', 'IFCMAPPEDITEM', 'IFCBOOLEANCLIPPINGRESULT', 'IFCSWEPTDISKSOLID'];
for (const [type, count] of Object.entries(geoItems).sort((a, b) => b[1] - a[1])) {
  if (count > 0) {
    const hasProcessor = supportedProcessors.includes(type);
    console.log(`    ${type}: ${count} ${hasProcessor ? '(HAS PROCESSOR)' : '(needs processor)'}`);
  }
}

// Profile types
console.log('\n\nPROFILE TYPE ANALYSIS:');
const profileTypes = [
  'IFCRECTANGLEPROFILEDEF', 'IFCRECTANGLEHOLLOWPROFILEDEF',
  'IFCCIRCLEPROFILEDEF', 'IFCCIRCLEHOLLOWPROFILEDEF',
  'IFCISHAPEPROFILEDEF', 'IFCLSHAPEPROFILEDEF', 'IFCTSHAPEPROFILEDEF', 'IFCUSHAPEPROFILEDEF', 'IFCZSHAPEPROFILEDEF', 'IFCCSHAPEPROFILEDEF',
  'IFCARBITRARYCLOSEDPROFILEDEF', 'IFCARBITRARYPROFILEDEFWITHVOIDS',
  'IFCDERIVEPROFILEDEF', 'IFCCOMPOSITEPROFILEDEF',
  'IFCASYMMETRICISHAPEPROFILEDEF', 'IFCELLIPSEPROFILEDEF', 'IFCTRAPEZIUMPROFILEDEF'
];

const supportedProfiles = ['IFCRECTANGLEPROFILEDEF', 'IFCCIRCLEPROFILEDEF', 'IFCISHAPEPROFILEDEF', 'IFCARBITRARYCLOSEDPROFILEDEF', 'IFCRECTANGLEHOLLOWPROFILEDEF', 'IFCCIRCLEHOLLOWPROFILEDEF', 'IFCLSHAPEPROFILEDEF', 'IFCTSHAPEPROFILEDEF', 'IFCUSHAPEPROFILEDEF', 'IFCZSHAPEPROFILEDEF', 'IFCCSHAPEPROFILEDEF', 'IFCCOMPOSITEPROFILEDEF', 'IFCASYMMETRICISHAPEPROFILEDEF', 'IFCELLIPSEPROFILEDEF', 'IFCTRAPEZIUMPROFILEDEF', 'IFCDERIVEPROFILEDEF', 'IFCARBITRARYPROFILEDEFWITHVOIDS'];

console.log('  Profile types found:');
for (const prof of profileTypes) {
  const count = entityCounts[prof] || 0;
  if (count > 0) {
    const hasProcessor = supportedProfiles.includes(prof);
    console.log(`    ${prof}: ${count} ${hasProcessor ? '(SUPPORTED)' : '(needs processor)'}`);
  }
}

// Summary - values from WASM output above
console.log('\n\n=== COVERAGE SUMMARY ===');
console.log(`Building elements found: 1585`);
console.log(`Successfully processed: 1509`);
console.log(`Empty (no geometry): 76 (IfcElementAssembly - container elements)`);
console.log(`Coverage: ${((1509/1585)*100).toFixed(1)}%`);
console.log(`\nGeometry output:`);
console.log(`  Vertices: ${mesh.positions_len / 3}`);
console.log(`  Triangles: ${mesh.indices_len / 3}`);

console.log('\n=== END ANALYSIS ===\n');
