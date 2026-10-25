/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Opt-in #7655 lifecycle tracing. Logging perturbs timing: diagnostic runs
 * are failure evidence, never performance measurements. Keep this function
 * self-contained because Playwright installs its source before viewer boot. */
export function installInstanceDiagnostics(): void {
  const host = globalThis as unknown as Record<string, unknown>;
  if (host.__ifc_lite_instance_diagnostics__) return;
  host.__ifc_lite_instance_diagnostics__ = true;
  const devices = new WeakMap<object, number>();
  const adapters = new WeakMap<object, number>();
  let nextDevice = 0, nextAdapter = 0, nextRequest = 0, nextPipeline = 0;
  const emit = (event: string, fields: Record<string, unknown>) => {
    console.info('[instance-diagnostics]', JSON.stringify({ event, wallMs: Date.now(), pageMs: performance.now(), ...fields }));
  };
  const identity = (map: WeakMap<object, number>, value: object, allocate: () => number) => {
    let id = map.get(value);
    if (id === undefined) { id = allocate(); map.set(value, id); }
    return id;
  };
  const deviceId = (device: object) => identity(devices, device, () => ++nextDevice);
  type Method = (this: object, ...args: unknown[]) => unknown;
  const wrap = (type: string, method: string, make: (original: Method) => Method) => {
    const prototype = (host[type] as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    const original = prototype?.[method];
    if (!prototype || typeof original !== 'function') {
      emit('hook-unavailable', { type, method }); return;
    }
    prototype[method] = make(original as Method);
  };
  wrap('GPUAdapter', 'requestDevice', original => function (...args) {
    const request = ++nextRequest;
    const adapter = identity(adapters, this, () => ++nextAdapter);
    emit('request-device', { request, adapter, descriptor: args[0] ?? null });
    try {
      const result = original.apply(this, args) as Promise<object & { lost: Promise<{ reason: string; message: string }> }>;
      void result.then(device => {
        const id = deviceId(device);
        emit('device-created', { request, adapter, device: id });
        void device.lost.then(info => {
          emit('device-lost', { device: id, reason: info.reason, message: info.message });
        }, error => emit('device-lost-rejected', { device: id, error: String(error) }));
      }, error => emit('request-device-rejected', { request, adapter, error: String(error) }));
      return result;
    } catch (error) {
      emit('request-device-threw', { request, adapter, error: String(error) }); throw error;
    }
  });
  wrap('GPUDevice', 'destroy', original => function (...args) {
    const device = deviceId(this);
    emit('device-destroy', { device, stack: new Error('device.destroy caller').stack });
    try { return original.apply(this, args); }
    catch (error) { emit('device-destroy-threw', { device, error: String(error) }); throw error; }
  });
  wrap('GPUDevice', 'createRenderPipelineAsync', original => function (...args) {
    const device = deviceId(this), pipeline = ++nextPipeline;
    const descriptor = args[0] as { label?: string; vertex?: { entryPoint?: string } } | undefined;
    emit('pipeline-request', { device, pipeline, label: descriptor?.label ?? null, vertexEntryPoint: descriptor?.vertex?.entryPoint ?? null });
    try {
      const result = original.apply(this, args) as Promise<unknown>;
      void result.then(
        () => emit('pipeline-created', { device, pipeline }),
        error => emit('pipeline-rejected', { device, pipeline, error: String(error) }),
      );
      return result;
    } catch (error) {
      emit('pipeline-threw', { device, pipeline, error: String(error) }); throw error;
    }
  });
  emit('installed', {});
}

/** The identity helper supplies esbuild's keep-names helper after serialization. */
export function instanceDiagnosticsInitScript(): string {
  return `(() => { const __name = (target) => target; (${installInstanceDiagnostics.toString()})(); })();`;
}
