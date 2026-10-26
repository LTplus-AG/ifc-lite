// SPDX-License-Identifier: MPL-2.0
// Generate the shape dispatch from the same schema as typed construction.
const quote = JSON.stringify;
const fields = (node) => `&[${Object.entries(node.fields).map(([key, ref]) => `(${quote(key)}, ${quote(ref)})`).join(', ')}]`;
const snake = (text) => text.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
export function rustWire(schema, roots) {
  const shape = (node) => {
    switch (node.kind) {
      case 'record': return `WireShape::Record(${fields(node)})`;
      case 'union': return `WireShape::Union(${quote(node.tag)}, &[${Object.entries(node.variants)
        .map(([tag, ref]) => `(${quote(tag)}, ${fields(schema.types[ref])})`).join(', ')}])`;
      case 'list': return `WireShape::List(${quote(node.item)}, ${node.min}, ${node.max})`;
      case 'enum': case 'text': return 'WireShape::Text';
      case 'number': return 'WireShape::Number';
      case 'bool': return 'WireShape::Boolean';
      case 'literal': return `WireShape::${{ string: 'Text', number: 'Number', boolean: 'Boolean' }[typeof node.value]}`;
      default: throw new Error('Unknown wire shape');
    }
  };
  return `const MAX_WIRE_BYTES: usize = ${schema.maxWireBytes};\nconst MAX_WIRE_DEPTH: usize = ${schema.maxWireDepth};\n`
    + `fn wire_shape(name: &str) -> WireShape { match name {\n${Object.entries(schema.types)
      .map(([name, node]) => `    ${quote(name)} => ${shape(node)},`).join('\n')}\n    _ => unreachable!("generated wire type"),\n} }\n`
    + [...roots, 'Binding'].map((name) => {
      const report = ['ModelReport', 'InspectionReport'].includes(name);
      const check = report ? `validate_${name === 'ModelReport' ? 'model' : 'inspection'}(&value, binding)`
        : name === 'Binding' ? 'binding_context(&value)' : `check_${snake(name)}(&value)`;
      return `fn decode_${snake(name)}(json: &str${report ? ', binding: &Binding' : ''}) -> Result<${name}, String> {\n`
        + `    let value = read_wire(${quote(name)}, json)?;\n    ${check}.map_err(str::to_owned)?;\n    Ok(value)\n}\n`;
    }).join('');
}
