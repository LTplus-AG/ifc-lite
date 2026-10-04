/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { register } from 'tsx/esm/api';

const moduleScopes = new Map();
function modules(sourceDir, options) {
  const key = JSON.stringify([sourceDir, options.parentURL, options.tsconfig]);
  if (!moduleScopes.has(key)) {
    // One supported import scope preserves canonical instanceof identity.
    // Repeated tsImport calls would each create a distinct UUID module graph.
    const scope = register({ namespace: `ifc-lineage-${createHash('sha256').update(key).digest('hex')}`,
      tsconfig: options.tsconfig });
    moduleScopes.set(key, Promise.all([
      scope.import(join(sourceDir, 'packages/parser/src/index.ts'), options.parentURL),
      scope.import(join(sourceDir, 'packages/parser/src/worker-index-publication.ts'), options.parentURL),
      scope.import(join(sourceDir, 'packages/parser/src/worker-parser.ts'), options.parentURL),
      scope.import(new URL('./interleaved-diagnostics.ts', import.meta.url).pathname, options.parentURL),
    ]));
  }
  return moduleScopes.get(key);
}

// Real parser/publication/hydration. The Worker adapter transports actual
// serialized payloads; it neither parses nor fabricates data-store results.
export async function canonicalStorePublication(sourceDir, options) {
  const [{ IfcParser }, { WorkerIndexPublisher }, { WorkerParser }, { installReadinessMilestones }] = await modules(sourceDir, options);
  const bytes = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n'
    + "#10=IFCWALL('0YvCT2_$X3_xJG3rzD8L_8',$,'Wall-A',$,$,$,$,$,$);\n"
    + "#11=IFCPROPERTYSINGLEVALUE('Example',$,IFCLABEL('present'),$);\n"
    + "#12=IFCPROPERTYSET('0YvCT2_$X3_xJG3rzD8L_9',$,'Pset_Example',$,(#11));\n"
    + "#13=IFCRELDEFINESBYPROPERTIES('0YvCT2_$X3_xJG3rzD8L_A',$,$,$,(#10),#12);\n"
    + 'ENDSEC;\nEND-ISO-10303-21;\n');
  const publisher = new WorkerIndexPublisher(true);
  let partialPayload;
  const parsed = await new IfcParser().parseColumnar(bytes.buffer, {
    disableWorkerScan: true, deferPropertyAtomIndex: true,
    onSpatialReady(store) {
      const envelope = publisher.serialize(store, false);
      partialPayload = structuredClone(envelope.payload, { transfer: envelope.transfers });
      publisher.publishedPartial(store);
    },
  });
  const expectedProperties = parsed.getProperties(10);
  const envelope = publisher.serialize(parsed, true);
  const fullPayload = structuredClone(envelope.payload, { transfer: envelope.transfers });
  const source = new SharedArrayBuffer(bytes.byteLength); new Uint8Array(source).set(bytes);
  const file = { name: 'lineage.ifc', size: bytes.byteLength };
  return { source, file, expectedProperties, partialPayload, fullPayload,
    install(onSpatial) {
      const names = ['Worker', 'HTMLInputElement', '__ifc_lite_comparison_milestones__'];
      const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
      const originalLog = console.log, originalQuery = document.querySelector;
      const documentDescriptors = new Map(['querySelector', 'addEventListener']
        .map(name => [name, Object.getOwnPropertyDescriptor(document, name)]));
      let latest, change, parser;
      function cleanup() {
        try { parser?.terminate(); } finally {
          console.log = originalLog;
          for (const [name, descriptor] of documentDescriptors) {
            if (descriptor) Object.defineProperty(document, name, descriptor); else delete document[name];
          }
          for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
          }
        }
      }
      class BoundaryWorker {
        constructor() { latest = this; this.id = ''; }
        postMessage(message) { if (message.type === 'parse') this.id = message.id; }
        terminate() { this.terminated = true; }
        emit(type, payload) { this.onmessage?.({ data: { type, id: this.id, payload,
          memory: { transportBytes: 0, sourceBytes: source.byteLength, parseTimeMs: 0 } } }); }
      }
      class FileInput { constructor() { this.files = [file]; } }
      const input = new FileInput();
      try {
      Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: BoundaryWorker });
      Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, writable: true, value: FileInput });
      document.querySelector = selector => selector === 'input[type="file"]' ? input : Reflect.apply(originalQuery, document, [selector]);
      document.addEventListener = (name, callback) => { if (name === 'change') change = callback; };
      installReadinessMilestones(); change({ target: input });
      parser = new WorkerParser();
      const pending = parser.parseColumnar(source, { onSpatialReady: onSpatial });
      return { pending, worker: latest,
        partial() { console.log(`[useIfc] Spatial tree ready for ${file.name} at 1ms`); latest.emit('partial-store', partialPayload); },
        complete() { latest.emit('complete', fullPayload); return pending; },
        metadataComplete() { console.log(`[useIfc] Data model parsing complete for ${file.name}: 2ms`); },
        cleanup };
      } catch (error) { cleanup(); throw error; }
    } };
}
