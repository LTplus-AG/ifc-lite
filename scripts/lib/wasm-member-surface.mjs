// SPDX-License-Identifier: MPL-2.0
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Semantic module/declaration closure, including typeof-import aliases.
 * Keep all declarations in each reachable module (a conservative superset), so
 * non-exported types used by public signatures cannot hide an API change.
 */
export function wasmMemberSurface(entry) {
  const program = ts.createProgram([entry], { target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, noEmit: true, skipLibCheck: false, types: [] });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => dirname(entry), getCanonicalFileName: path => path, getNewLine: () => '\n',
  }));
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const rows = [];
  const files = program.getSourceFiles().filter(file => !program.isSourceFileDefaultLibrary(file));
  const fileName = file => program.isSourceFileDefaultLibrary(file)
    ? `typescript/${file.fileName.split(/[\\/]/u).at(-1)}`
    : relative(dirname(entry), file.fileName).replaceAll('\\', '/');
  const resolved = symbol => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  // A local spelling (Value, T, Public) is not a type identity. Include the
  // resolved declaration's module and lexical owner, without machine paths.
  const identity = symbol => {
    const target = resolved(symbol);
    if (!target.declarations?.length) throw new Error(`Unresolved symbol ${symbol.name}`);
    return [...new Set(target.declarations.map(declaration => {
      const owners = [];
      for (let node = declaration; node && !ts.isSourceFile(node); node = node.parent) {
        if (node.name) owners.unshift(printer.printNode(ts.EmitHint.Unspecified, node.name, node.getSourceFile()));
      }
      return `${fileName(declaration.getSourceFile())}::${owners.join('.') || (ts.isSourceFile(declaration) ? '<module>' : target.name)}`;
    }))].sort().join('|');
  };
  for (const file of files) {
    const name = fileName(file);
    const symbol = checker.getSymbolAtLocation(file);
    if (symbol) {
      for (const exported of checker.getExportsOfModule(symbol)) {
        const target = resolved(exported);
        if (!target.declarations?.length) throw new Error(`Unresolved export ${name}:${exported.name}`);
        const types = [];
        if (target.flags & ts.SymbolFlags.Type) types.push(['type', checker.getDeclaredTypeOfSymbol(target)]);
        if (target.flags & ts.SymbolFlags.Value) types.push(['value', checker.getTypeOfSymbolAtLocation(
          target, target.valueDeclaration ?? target.declarations[0])]);
        rows.push(`${name} export ${exported.name} => ${identity(target)}: ${types.map(([kind, type]) =>
          `${kind} ${checker.typeToString(type, file, ts.TypeFormatFlags.NoTruncation)}`).join('; ')}`);
      }
    }
    const transformed = ts.transform(file, [context => {
      const visit = node => {
        // Match the canonical generator's platform-only exclusions. Private
        // implementation fields are not consumer members; private constructors
        // ARE a consumer restriction and remain in the snapshot.
        if (node.name && ts.isIdentifier(node.name) && node.name.text.startsWith('__wasm_bindgen_func_elem_')) return undefined;
        if (!ts.isConstructorDeclaration(node) && ts.canHaveModifiers(node)
          && ts.getModifiers(node)?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword)) return undefined;
        // Canonical bindings for parameter/return references, type arguments,
        // constraints/defaults, typeof queries, imports and type-only aliases.
        // Retain their printed declarations too: readonly/static/overload and
        // type-only/value restrictions are part of the consumer contract.
        if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)
          || ts.isTypeQueryNode(node) || ts.isImportTypeNode(node)) {
          const location = node.typeName ?? node.expression ?? node.exprName ?? node.qualifier;
          const target = location && checker.getSymbolAtLocation(location);
          if (target) rows.push(`${name} reference ${printer.printNode(ts.EmitHint.Unspecified, node, file)} => ${identity(target)}`);
        }
        if ((ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)
          || ts.isImportEqualsDeclaration(node)) && node.name) {
          const target = checker.getSymbolAtLocation(node.name);
          if (!target) throw new Error(`Unresolved import ${name}:${node.name.text}`);
          rows.push(`${name} import ${node.name.text} => ${identity(target)}`);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return node => ts.visitNode(node, visit);
    }]);
    try {
      for (const statement of transformed.transformed[0].statements) {
        rows.push(`${name} ${printer.printNode(ts.EmitHint.Unspecified, statement, file).trim()}`);
      }
    } finally { transformed.dispose(); }
  }
  return { rows: [...new Set(rows)].sort(), files: files.map(file => resolve(file.fileName)).sort() };
}

export function publishedWasmMembers(root) {
  return Object.fromEntries([
    ['@ifc-lite/wasm#members', 'packages/wasm/pkg/ifc-lite.d.ts'],
    ['@ifc-lite/wasm/retained#members', 'packages/wasm/retained.d.ts'],
  ].map(([key, path]) => [key, wasmMemberSurface(resolve(root, path)).rows]));
}
