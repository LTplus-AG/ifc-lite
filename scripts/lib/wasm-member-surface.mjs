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
  for (const file of files) {
    const name = relative(dirname(entry), file.fileName).replaceAll('\\', '/');
    const symbol = checker.getSymbolAtLocation(file);
    if (symbol) {
      for (const exported of checker.getExportsOfModule(symbol)) {
        const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        if (!target.declarations?.length) throw new Error(`Unresolved export ${name}:${exported.name}`);
        rows.push(`${name} export ${exported.name}: ${checker.typeToString(
          checker.getTypeOfSymbolAtLocation(target, target.valueDeclaration ?? target.declarations[0]),
          file, ts.TypeFormatFlags.NoTruncation)}`);
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
        return ts.visitEachChild(node, visit, context);
      };
      return node => ts.visitNode(node, visit);
    }]);
    try {
      for (const statement of transformed.transformed[0].statements) {
        if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) continue;
        rows.push(`${name} ${printer.printNode(ts.EmitHint.Unspecified, statement, file).trim()}`);
      }
    } finally { transformed.dispose(); }
  }
  return { rows: rows.sort(), files: files.map(file => resolve(file.fileName)).sort() };
}

export function publishedWasmMembers(root) {
  return Object.fromEntries([
    ['@ifc-lite/wasm#members', 'packages/wasm/pkg/ifc-lite.d.ts'],
    ['@ifc-lite/wasm/retained#members', 'packages/wasm/retained.d.ts'],
  ].map(([key, path]) => [key, wasmMemberSurface(resolve(root, path)).rows]));
}
