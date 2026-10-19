// D47/#7895 external public-boundary witness. PREPARED ONLY; never run in preparation.
// All IFC is expanded from committed normative vectors; no IFC parser/budget calculator.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root = resolve(process.argv[2]);
const sha = b => createHash('sha256').update(b).digest('hex');
const vectorBytes = readFileSync(join(root,'packages/parser/test/fixtures/complex-property-budget-7675.json'));
assert.equal(sha(vectorBytes),'e1c313ac797ab05a7ea7c237d932d648d37872304987f4ea598363e3334dc988');
const vectors = JSON.parse(vectorBytes).cases;
const order = JSON.parse(readFileSync(join(root,'rust/export/tests/fixtures/shared_set_order_7895.json')));
const shared = vectors.find(c => c.name === 'shared-set');
const marker = '(truncated: nested properties over the walk budget)';
const wrap = lines => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"+lines.join('\n')+'\nENDSEC;\nEND-ISO-10303-21;\n');
function expand(c) {
  return c.dataLines.flatMap(line => typeof line === 'string' ? [line] :
    Array.from({length:line.count},(_,k)=>line.repeat.map(t=>t.replaceAll('{i}',String(line.from+k)))).flat());
}
function ordered(c) {
  const lines = [];
  for (const line of shared.dataLines) {
    assert.equal(typeof line,'string');
    if (line.startsWith('#40=')) continue;
    const set = line.startsWith('#30=');
    if (set && c.shadow) lines.push(order.shadowSet);
    lines.push(line);
    if (set) lines.push(order.secondSet,...c.types);
  }
  return wrap([...lines,...c.relationships]);
}
function pinValues(values,pin) {
  assert.equal(values.length,pin.count);
  values.forEach(value=>assert.equal(typeof value,'string'));
  if (pin.values) assert.deepEqual(values,pin.values);
  else {
    // Normative pins describe the newline-joined property values of one set,
    // exactly as assert_pins in the existing raw Python consumer fixture.
    const joined=values.join('\n');
    assert.equal(Buffer.byteLength(joined),pin.length);
    assert.equal(sha(joined),pin.sha256);
  }
}
const {initSync,IfcAPI} = await import(pathToFileURL(join(root,'packages/wasm/pkg/ifc-lite.js')).href);
const wasm = readFileSync(join(root,'packages/wasm/pkg/ifc-lite_bg.wasm'));
initSync(wasm);
const api = new IfcAPI();
const decode = b => new TextDecoder().decode(b);
let cases = 0;
try {
  function check(bytes,shape,pins,rowCount) {
    const json = JSON.parse(decode(api.exportJson(bytes,false,true,true)));
    assert.equal(json.length,rowCount);
    const expected = new Map(shape);
    const actualNames = row => (row.propertySets ?? []).map(s=>s.name);
    for (const row of json) {
      assert.deepEqual(actualNames(row),expected.get(row.expressId) ?? []);
      for (const set of row.propertySets ?? []) {
        const pin = pins.get(set.name);assert.ok(pin);assert.equal(set.properties.length,pin.count);
        pinValues(set.properties.map(prop=>prop.value),pin);
      }
    }
    const csv = decode(api.exportCsv(bytes,'properties','\t',false));
    const positions = new Map();let csvCount=0;
    for (const line of csv.trimEnd().split('\n').slice(1)) {
      const cells=line.replace(/\r$/,'').split('\t');assert.equal(cells.length,8);
      const id=Number(cells[0]),name=cells[4],key=id+'|'+name;
      assert.ok((expected.get(id) ?? []).includes(name));
      const values=positions.get(key) ?? [];values.push(cells[6]);positions.set(key,values);csvCount++;
    }
    assert.equal(csvCount,shape.reduce((n,[,names])=>n+names.reduce((m,name)=>m+pins.get(name).count,0),0));
    for (const [id,names] of shape) for (const name of names) {
      pinValues(positions.get(id+'|'+name) ?? [],pins.get(name));
    }
    const doc=JSON.parse(decode(api.exportJsonld(bytes,'',true,true,false,undefined)));
    assert.equal(doc['@graph'].length,rowCount);
    for (const row of doc['@graph']) {
      const sets=row['ifc:hasPropertySets'] ?? [];
      assert.deepEqual(sets.map(s=>s['ifc:name']),expected.get(row['ifc:expressId']) ?? []);
      for (const set of sets) {
        const pin=pins.get(set['ifc:name']);assert.equal(set['ifc:hasProperties'].length,pin.count);
        set['ifc:hasProperties'].forEach((prop,i)=>{
          assert.equal(prop['@type'],'ifc:IfcComplexProperty');
        });
        pinValues(set['ifc:hasProperties'].map(prop=>prop['ifc:nominalValue']),pin);
      }
    }
    assert.deepEqual(JSON.parse(decode(api.exportJsonld(bytes,'',true,true,false,new Uint32Array())))['@graph'],[]);
    const omitted=JSON.parse(decode(api.exportJsonld(bytes,'',false,true,false,undefined)));
    assert.ok(omitted['@graph'].every(row=>!('ifc:hasPropertySets' in row)));
    cases++;
  }
  for (const name of ['shared-set','unnamed-member','duplicated-set-record','duplicate-records-differ']) {
    const c=vectors.find(v=>v.name===name);assert.ok(c);
    if(name==='shared-set') assert.equal(c.cuts,1);
    assert.ok(c.entityIds.every(Number.isInteger));
    check(wrap(expand(c)),c.entityIds.map(id=>[id,c.psets.map(s=>s.name)]),new Map(c.psets.map(s=>[s.name,s])),c.entityIds.length);
  }
  const orderPins=new Map([['Pset_Shared',shared.psets[0]],['Pset_Second',{count:1,values:[marker]}]]);
  for (const c of order.cases) check(ordered(c),c.own,orderPins,c.rowCount);
  const opposed=order.cases[1];
  const unlinked=new TextEncoder().encode(new TextDecoder().decode(ordered(opposed)).replace(opposed.relationships[0],''));
  check(unlinked,[[100,['Pset_Second']]],orderPins,200);
  // Existing seven-class fixture and expected values are the parent02 contract, not inferred classes.
  const kindsBytes=readFileSync(join(root,'rust/export/tests/fixtures/c6_data_model_synthetic.ifc'));
  const graph=JSON.parse(decode(api.exportJsonld(kindsBytes,'',true,true,false,new Uint32Array([330]))))['@graph'];
  const all=graph.find(n=>n['ifc:expressId']===330)['ifc:hasPropertySets'].find(s=>s['ifc:name']==='Pset_AllKinds')['ifc:hasProperties'];
  const expected=[['Text','IfcPropertySingleValue','Fire ä proof'],['Flag','IfcPropertySingleValue',true],['Unknown','IfcPropertySingleValue','unknown'],['Thickness','IfcPropertySingleValue',0.2],['Status','IfcPropertyEnumeratedValue','NEW, EXISTING'],['Range','IfcPropertyBoundedValue','2 [1 – 5]'],['Sizes','IfcPropertyListValue','1, 2, 3'],['Curve','IfcPropertyTableValue','Table (2 rows)'],['Ref','IfcPropertyReferenceValue','Target'],['Complex','IfcComplexProperty','Inner1: a, Inner2: 2.5']];
  assert.deepEqual(all.map(p=>[p['ifc:name'],p['@type'].slice(4),p['ifc:nominalValue']]),expected);
  const ambiguous=readFileSync(new URL('./ambiguous-parent02.ifc',import.meta.url));
  const ambiguousGraph=JSON.parse(decode(api.exportJsonld(ambiguous,'',true,true,false,undefined)))['@graph'];
  assert.deepEqual(ambiguousGraph.map(n=>n['ifc:expressId']),[1,2,3]);
  for (const row of ambiguousGraph) {
    assert.equal(row['ifc:hasPropertySets'].length,1);
    const props=row['ifc:hasPropertySets'][0]['ifc:hasProperties'];
    assert.deepEqual(props.map(v=>[v['ifc:name'],v['@type'],v['ifc:nominalValue']]),[
      ['Same','ifc:IfcPropertySingleValue','x'],['Same','ifc:IfcPropertyEnumeratedValue','x'],['Same','ifc:IfcPropertyListValue','x']]);
    if(row['ifc:expressId']!==3) assert.equal(row['ifc:hasQuantitySets'][0]['ifc:quantities'][0]['@type'],'ifc:IfcQuantityLength');
  }
  console.log(JSON.stringify({state:'PASS',budgetCases:cases,allSevenClasses:true,wasmSha256:sha(wasm),scope:'own/default export options; no wasm inheritance/SingleValueOnly API exists'}));
} finally { api.free(); }
