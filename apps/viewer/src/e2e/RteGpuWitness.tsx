/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit, hardware-only #5049 renderer acceptance route.
 *
 * This deliberately drives the shipping Renderer rather than a test shader or
 * a canvas mock. It is not a general diagnostic UI: `/rte-gpu-witness` exists
 * so a reviewer can collect one reproducible WebGPU report from a real browser
 * and inspect the production ID-buffer readback, shadow pass and RTE uniforms.
 */

import { useEffect, useRef, useState } from 'react';
import { Renderer, type PickResult } from '@ifc-lite/renderer';
import {
  COMMON_ORIGIN, LARGE_ORIGIN, PICK_CSS_X, PICK_CSS_Y, CPU_PICK_CSS_X, CPU_PICK_CSS_Y, GEOMETRIC_TOLERANCE_METRES,
  baseReport, distance, instancedShard, largeExtentMesh, shadowCasterMesh, type PickEvidence, type RteGpuWitnessReport, witnessMesh,
} from './RteGpuWitnessFixtures';
import { isForeground, screenshotDifference, screenshotPixel } from './RteGpuWitnessPixels';

declare global {
  interface Window {
    __ifc_lite_rte_gpu_witness__?: RteGpuWitnessReport;
  }
}


function publish(report: RteGpuWitnessReport): void {
  window.__ifc_lite_rte_gpu_witness__ = report;
}

function pickEvidence(pick: PickResult | null): PickEvidence | null {
  if (!pick) return null;
  return {
    expressId: pick.expressId,
    ...(pick.modelIndex === undefined ? {} : { modelIndex: pick.modelIndex }),
    ...(pick.geometryItemId === undefined ? {} : { geometryItemId: pick.geometryItemId }),
    ...(pick.worldXYZ === undefined ? {} : { worldXYZ: [pick.worldXYZ.x, pick.worldXYZ.y, pick.worldXYZ.z] as [number, number, number] }),
  };
}

async function runWitness(canvas: HTMLCanvasElement): Promise<RteGpuWitnessReport> {
  const report = baseReport();
  if (!navigator.gpu) {
    report.status = 'skipped';
    report.reason = 'WebGPU is unavailable; no rendering claim was made.';
    return report;
  }

  const renderer = new Renderer(canvas);
  try {
    await renderer.init();
    const adapter = renderer.getAdapterInfo();
    report.system.adapter = adapter;
    const adapterText = `${adapter?.vendor ?? ''} ${adapter?.architecture ?? ''}`.toLowerCase();
    const hardwareVendor = /nvidia|amd|intel|apple|qualcomm|arm|imagination/;
    if (!adapter?.vendor || !hardwareVendor.test(adapterText) || /swiftshader|software|llvmpipe|warp/.test(adapterText)) {
      report.status = 'skipped';
      report.reason = 'A positively identified hardware adapter is required; unknown and software adapters (including SwiftShader) are not acceptance evidence.';
      return report;
    }
    report.system.hardwareVerified = true;

    const quantized = await renderer.enableQuantizedBatches();
    const flat = witnessMesh(101, COMMON_ORIGIN, [1, 0.15, 0.1, 1]);
    const textured = witnessMesh(102, [COMMON_ORIGIN[0] - 24, COMMON_ORIGIN[1], COMMON_ORIGIN[2]], [1, 1, 1, 1], true);
    // Two owning models with distinct derived representation-item provenance:
    // the pick/readback must not collapse them into a batch/material identity.
    flat.modelIndex = 11;
    flat.geometryItemId = 70_101;
    textured.modelIndex = 12;
    textured.geometryItemId = 70_102;
    renderer.loadGeometry([flat, textured, shadowCasterMesh(), largeExtentMesh()]);
    const device = renderer.getGPUDevice();
    if (!device) throw new Error('Renderer initialized without a live GPU device.');
    renderer.getScene().addInstancedShard(device, instancedShard());
    const pointHandle = renderer.beginPointCloudStream({ expressId: 105 });
    renderer.appendPointCloudChunk(pointHandle, {
      positions: new Float32Array([6, 0, 1, 7, 1, 1]),
      colors: new Float32Array([1, 1, 0, 1, 0, 1]),
      pointCount: 2,
      bbox: { min: [6, 0, 1], max: [7, 1, 1] },
    });
    renderer.setPointCloudTranslation(pointHandle, COMMON_ORIGIN);
    renderer.endPointCloudStream(pointHandle);
    renderer.setLineOverlay('alignment', {
      localVertices: new Float32Array([-12, 0, 1, 12, 0, 1]),
      origin: COMMON_ORIGIN,
    });
    renderer.setOverlayLineColor([1, 0.8, 0, 1]);
    renderer.setPointCloudOptions({ colorMode: 'fixed', fixedColor: [0, 1, 1, 1], sizeMode: 'fixed-px', pointSize: 24 });

    const camera = renderer.getCamera();
    camera.setPosition(COMMON_ORIGIN[0], COMMON_ORIGIN[1], COMMON_ORIGIN[2] + 60);
    camera.setTarget(COMMON_ORIGIN[0], COMMON_ORIGIN[1], COMMON_ORIGIN[2]);
    const sunEnvironment = { sunDirection: [0.4, 1, 0.35] as [number, number, number] };
    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const lineScreenshot = await renderer.captureScreenshot();
    const linePixel = await screenshotPixel(lineScreenshot, PICK_CSS_X, PICK_CSS_Y);

    const pick = await renderer.pick(PICK_CSS_X, PICK_CSS_Y);
    const cpuRay = renderer.raycastScene(CPU_PICK_CSS_X, CPU_PICK_CSS_Y, {
      snapOptions: {
        snapToVertices: true,
        snapToEdges: true,
        snapToFaces: true,
        screenSnapRadius: 24,
      },
    });
    const magnetic = renderer.raycastSceneMagnetic(CPU_PICK_CSS_X, CPU_PICK_CSS_Y, {
      edge: null,
      meshExpressId: null,
      lockStrength: 0,
    });
    const source = renderer.getScene().getMeshData(101);
    if (!source?.origin) throw new Error('Flat RTE source was not retained by the production scene.');
    const sourceResidualMetres = Math.abs(source.origin[0] - COMMON_ORIGIN[0]);
    const pickResidualMetres = pick?.worldXYZ ? Math.abs(pick.worldXYZ[2] - COMMON_ORIGIN[2]) : null;
    const snapResidualMetres = cpuRay?.snap
      ? distance(
        [cpuRay.snap.position.x, cpuRay.snap.position.y, cpuRay.snap.position.z],
        [cpuRay.intersection.point.x, cpuRay.intersection.point.y, cpuRay.intersection.point.z],
      )
      : null;
    // A second production ray/pick pair is only 1.5625 cm away. Measurement
    // compares those independently reconstructed f64 intersections; it is not
    // a fixture-coordinate arithmetic proxy.
    const centimetreTarget: [number, number, number] = [COMMON_ORIGIN[0] + 0.015625, COMMON_ORIGIN[1], COMMON_ORIGIN[2]];
    camera.setPosition(centimetreTarget[0], centimetreTarget[1], centimetreTarget[2] + 60);
    camera.setTarget(...centimetreTarget);
    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const centimetreGpuPick = await renderer.pick(PICK_CSS_X, PICK_CSS_Y);
    const centimetreCpuRay = renderer.raycastScene(CPU_PICK_CSS_X, CPU_PICK_CSS_Y);
    const measurementResidualMetres = pick?.worldXYZ && cpuRay && centimetreGpuPick?.worldXYZ && centimetreCpuRay
      ? Math.abs(
        distance([pick.worldXYZ.x, pick.worldXYZ.y, pick.worldXYZ.z], [centimetreGpuPick.worldXYZ.x, centimetreGpuPick.worldXYZ.y, centimetreGpuPick.worldXYZ.z])
        - distance([cpuRay.intersection.point.x, cpuRay.intersection.point.y, cpuRay.intersection.point.z], [centimetreCpuRay.intersection.point.x, centimetreCpuRay.intersection.point.y, centimetreCpuRay.intersection.point.z]),
      )
      : null;
    camera.setPosition(COMMON_ORIGIN[0], COMMON_ORIGIN[1], COMMON_ORIGIN[2] + 60);
    camera.setTarget(COMMON_ORIGIN[0], COMMON_ORIGIN[1], COMMON_ORIGIN[2]);
    const pipeline = renderer.getPipeline();
    if (!pipeline) throw new Error('Renderer did not retain its production pipeline.');
    renderer.getScene().setColorOverrides(new Map([[101, [0.8, 0.1, 1, 1]]]), device, pipeline);
    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    // Sample inside the face but away from the yellow alignment segment.
    const colorScreenshot = await renderer.captureScreenshot();
    const colorPixel = await screenshotPixel(colorScreenshot, PICK_CSS_X, PICK_CSS_Y + 60);

    camera.setPosition(COMMON_ORIGIN[0] - 24, COMMON_ORIGIN[1], COMMON_ORIGIN[2] + 60);
    camera.setTarget(COMMON_ORIGIN[0] - 24, COMMON_ORIGIN[1], COMMON_ORIGIN[2]);
    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const texturedScreenshot = await renderer.captureScreenshot();
    const texturedPixel = await screenshotPixel(texturedScreenshot, PICK_CSS_X, PICK_CSS_Y);
    const texturedPick = await renderer.pick(PICK_CSS_X, PICK_CSS_Y);
    camera.setPosition(COMMON_ORIGIN[0] + 24, COMMON_ORIGIN[1], COMMON_ORIGIN[2] + 60);
    camera.setTarget(COMMON_ORIGIN[0] + 24, COMMON_ORIGIN[1], COMMON_ORIGIN[2]);
    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const instancedScreenshot = await renderer.captureScreenshot();
    const instancedPixel = await screenshotPixel(instancedScreenshot, PICK_CSS_X, PICK_CSS_Y);
    const instancedPick = await renderer.pick(PICK_CSS_X, PICK_CSS_Y);
    camera.setPosition(COMMON_ORIGIN[0] + 6, COMMON_ORIGIN[1], COMMON_ORIGIN[2] + 61);
    camera.setTarget(COMMON_ORIGIN[0] + 6, COMMON_ORIGIN[1], COMMON_ORIGIN[2] + 1);
    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const pointScreenshot = await renderer.captureScreenshot();
    const pointPixel = await screenshotPixel(pointScreenshot, PICK_CSS_X, PICK_CSS_Y);
    const pointPick = await renderer.pick(PICK_CSS_X, PICK_CSS_Y);
    const pointCrop = {
      enabled: true,
      min: [COMMON_ORIGIN[0] - 1, COMMON_ORIGIN[1] - 1, COMMON_ORIGIN[2] + 2] as [number, number, number],
      max: [COMMON_ORIGIN[0] + 12, COMMON_ORIGIN[1] + 12, COMMON_ORIGIN[2] + 12] as [number, number, number],
    };
    renderer.render({ clipBox: pointCrop, environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const pointCropClick = (await renderer.pick(PICK_CSS_X, PICK_CSS_Y)) === null;
    const pointCropRectangle = (await renderer.pickRect(PICK_CSS_X - 12, PICK_CSS_Y - 12, PICK_CSS_X + 12, PICK_CSS_Y + 12)).size === 0;
    camera.setPosition(COMMON_ORIGIN[0], COMMON_ORIGIN[1], COMMON_ORIGIN[2] + 60);
    camera.setTarget(COMMON_ORIGIN[0], COMMON_ORIGIN[1], COMMON_ORIGIN[2]);

    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const unselectedScreenshot = await renderer.captureScreenshot();

    renderer.render({ selectedId: 101, clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const highlightScreenshot = await renderer.captureScreenshot();
    const highlightPixels = await screenshotDifference(unselectedScreenshot, highlightScreenshot);
    renderer.render({
      sunShadows: { enabled: true, resolution: 512 }, clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment,
    });
    await device.queue.onSubmittedWorkDone();
    const shadowScreenshot = await renderer.captureScreenshot();
    const shadowPixels = await screenshotDifference(unselectedScreenshot, shadowScreenshot);

    // The picker must consume the same RTE fragment-space crop and custom
    // section plane that the production render used. The central flat triangle
    // lies below both cuts, so a hit here is a real parity failure.
    const crop = {
      enabled: true,
      min: [COMMON_ORIGIN[0] - 30, COMMON_ORIGIN[1] - 30, COMMON_ORIGIN[2] + 1] as [number, number, number],
      max: [COMMON_ORIGIN[0] + 30, COMMON_ORIGIN[1] + 30, COMMON_ORIGIN[2] + 30] as [number, number, number],
    };
    renderer.render({ clipBox: crop, environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const clippedPick = (await renderer.pick(PICK_CSS_X, PICK_CSS_Y)) === null;
    renderer.render({ sectionPlane: { axis: 'front', position: 50, enabled: true, normal: [0, 0, 1], distance: COMMON_ORIGIN[2] - 1 }, environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const sectionPick = (await renderer.pick(PICK_CSS_X, PICK_CSS_Y)) === null;

    // Exercise a separately-large local extent with a camera in that frame;
    // it shares the exact production RTE draw path but cannot hide a precision
    // loss behind the national-grid common translation fixture.
    camera.setPosition(LARGE_ORIGIN[0], LARGE_ORIGIN[1], LARGE_ORIGIN[2] + 15_000);
    camera.setTarget(LARGE_ORIGIN[0], LARGE_ORIGIN[1], LARGE_ORIGIN[2]);
    renderer.render({ clearColor: [0.02, 0.02, 0.02, 1], environment: sunEnvironment });
    await device.queue.onSubmittedWorkDone();
    const largeExtentScreenshot = await renderer.captureScreenshot();
    const largeExtentPixel = await screenshotPixel(largeExtentScreenshot, PICK_CSS_X, PICK_CSS_Y);
    const largeExtentPick = await renderer.pick(PICK_CSS_X, PICK_CSS_Y);
    const screenshot = await renderer.captureScreenshot();
    const diagnostics = renderer.getDiagnostics();

    const cpuPoint = cpuRay?.intersection.point;
    const cpuRayEvidence = cpuRay
      ? { expressId: cpuRay.intersection.expressId, point: [cpuPoint.x, cpuPoint.y, cpuPoint.z] as [number, number, number] }
      : null;
    const gpuCpuResidual = pick?.worldXYZ && cpuRayEvidence ? distance(pick.worldXYZ, cpuRayEvidence.point) : Infinity;
    report.evidence = {
      canvasPixels: { width: canvas.width, height: canvas.height },
      pickPixel: { x: PICK_CSS_X, y: PICK_CSS_Y },
      pick: pickEvidence(pick),
      texturedPick: pickEvidence(texturedPick),
      instancedPick: pickEvidence(instancedPick),
      pointPick: pickEvidence(pointPick),
      largeExtentPick: pickEvidence(largeExtentPick),
      pointCropClick,
      pointCropRectangle,
      linePixel,
      texturedPixel,
      instancedPixel,
      pointPixel,
      largeExtentPixel,
      colorPixel,
      highlightPixels,
      shadowPixels,
      cpuRay: cpuRayEvidence,
      sourceResidualMetres,
      pickResidualMetres,
      CPUAndGpuAgree: gpuCpuResidual <= GEOMETRIC_TOLERANCE_METRES,
      snapResidualMetres,
      measurementResidualMetres,
      provenanceStable: pick?.expressId === 101 && pick.geometryItemId === 70_101
        && pick.modelIndex === 11 && texturedPick?.expressId === 102 && texturedPick.modelIndex === 12
        && cpuRayEvidence?.expressId === 101 && magnetic.intersection?.expressId === 101
        && magnetic.intersection?.geometryItemId === 70_101,
      families: {
        flat: pick?.expressId === 101 && isForeground(linePixel),
        textured: texturedPick?.expressId === 102 && texturedPick.modelIndex === 12 && isForeground(texturedPixel),
        quantized: quantized && renderer.getScene().isMeshQuantized(flat) && pick?.expressId === 101 && isForeground(linePixel),
        instanced: instancedPick?.expressId === 103 && isForeground(instancedPixel),
        point: pointPick?.expressId === 105 && isForeground(pointPixel),
        anchoredLine: linePixel !== null && linePixel[0] > linePixel[2],
        color: colorPixel !== null && colorPixel[0] > colorPixel[1],
        shadow: shadowPixels !== null && shadowPixels.changedPixels > 0 && shadowPixels.maxChannelDelta > 1,
        picker: pick?.expressId === 101,
        highlight: highlightPixels !== null && highlightPixels.changedPixels > 0 && highlightPixels.maxChannelDelta > 1,
        section: sectionPick,
        crop: clippedPick && pointCropClick && pointCropRectangle,
        farOrigin: sourceResidualMetres <= GEOMETRIC_TOLERANCE_METRES,
        largeExtent: largeExtentPick?.expressId === 104 && isForeground(largeExtentPixel),
        cpuRay: cpuRayEvidence?.expressId === 101,
        snap: magnetic.snapTarget !== null || cpuRay?.snap !== undefined,
        measurement: measurementResidualMetres <= GEOMETRIC_TOLERANCE_METRES,
        identityProvenance: pick?.expressId === 101 && pick.geometryItemId === 70_101
          && pick.modelIndex === 11 && texturedPick?.expressId === 102 && texturedPick.modelIndex === 12
          && cpuRayEvidence?.expressId === 101 && magnetic.intersection?.expressId === 101
          && magnetic.intersection?.geometryItemId === 70_101,
      },
      clippedPick,
      sectionPick,
      screenshotBytes: screenshot?.length ?? 0,
      diagnostics: {
        gpuErrors: diagnostics.gpuErrors,
        errors: diagnostics.errors,
        lastGpuError: diagnostics.lastGpuError,
        lastError: diagnostics.lastError,
      },
    };
    const passed = Object.values(report.evidence.families).every(Boolean)
      && report.evidence.clippedPick
      && report.evidence.pointCropClick
      && report.evidence.pointCropRectangle
      && report.evidence.sectionPick
      && report.evidence.screenshotBytes > 100
      && report.evidence.sourceResidualMetres <= GEOMETRIC_TOLERANCE_METRES
      && report.evidence.pickResidualMetres !== null
      && report.evidence.pickResidualMetres <= GEOMETRIC_TOLERANCE_METRES
      && report.evidence.CPUAndGpuAgree
      && report.evidence.snapResidualMetres !== null
      && report.evidence.measurementResidualMetres <= GEOMETRIC_TOLERANCE_METRES
      && report.evidence.diagnostics.gpuErrors === 0
      && report.evidence.diagnostics.errors === 0;
    report.status = passed ? 'passed' : 'failed';
    if (!passed) report.reason = 'One or more production RTE acceptance assertions failed; inspect evidence.';
    return report;
  } catch (error) {
    console.error('[RTE GPU witness] production renderer run failed:', error);
    report.status = 'failed';
    report.reason = error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    renderer.destroy();
  }
}

export function RteGpuWitness() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [report, setReport] = useState<RteGpuWitnessReport>(() => baseReport());

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let live = true;
    void runWitness(canvas).then((next) => {
      publish(next);
      if (live) setReport(next);
    });
    return () => { live = false; };
  }, []);

  return (
    <main style={{ background: '#0b1020', color: '#e8eefc', minHeight: '100vh', padding: 24, fontFamily: 'ui-monospace, monospace' }}>
      <h1>RTE GPU witness (#5049)</h1>
      <p>Hardware-only production-renderer acceptance. Software adapters are reported as skipped, never passed.</p>
      <canvas ref={canvasRef} width={640} height={480} style={{ display: 'block', width: 640, height: 480, border: '1px solid #415078' }} />
      <pre aria-label="RTE GPU witness report" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(report, null, 2)}</pre>
    </main>
  );
}
