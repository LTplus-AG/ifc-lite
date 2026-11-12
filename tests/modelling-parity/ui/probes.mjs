import { PLAN_CAM } from './lib/probe-helpers.mjs';
export { PROBES } from './rows/index.mjs';
/** Run one probe in a fresh page. Returns a contract result plus the export text when the probe has one. */
export async function runProbe(probe, openFresh, base, { saveArtifact } = {}) {
  const s = await openFresh(probe.id);
  const t0 = Date.now();
  let out;
  let error = null;
  try {
    const { startBlank } = await import('./lib/model-ui.mjs');
    await startBlank(s, { count: false });
    await s.harness.aim(PLAN_CAM.pos, PLAN_CAM.target);
    out = await probe.run(s);
  } catch (e) {
    error = String(e.message ?? e).split('\n')[0].slice(0, 400);
    out = { tasks: s.completedTasks ?? [], checks: [], notes: [] };
  }
  const wall = Date.now() - t0;
  const counted = out.tasks.filter((t) => !t.setup);
  const setup = out.tasks.filter((t) => t.setup);
  const failedTasks = out.tasks.filter((t) => !t.ok);
  const okChecks = out.checks.filter((c) => c.ok).length;
  let status;
  if (error) status = 'error';
  // A failed task can leave an earlier, correct state behind; it never reads as a pass.
  else if (out.checks.length && okChecks === out.checks.length && !s.scriptedSteps.length && !failedTasks.length) status = 'pass';
  else if (okChecks > 0) status = 'partial';
  else status = 'fail';
  const reasons = [];
  if (error) reasons.push(`probe error: ${error}`);
  for (const c of out.checks.filter((x) => !x.ok)) reasons.push(`${c.name}: ${c.detail}`);
  for (const t of failedTasks) reasons.push(`task "${t.name}" failed: ${t.error}`);
  if (s.scriptedSteps.length) reasons.push(`scripted through the store: ${s.scriptedSteps.join(', ')}`);
  const result = {
    ...base,
    capability: probe.capability,
    probe: 'ui',
    id: probe.id,
    title: probe.title,
    status,
    ...(status === 'pass' ? {} : { reason: reasons.join('; ') || 'no check passed' }),
    metrics: {
      ms: counted.reduce((n, t) => n + t.ms, 0),
      actions: counted.reduce((n, t) => n + t.actions, 0),
      setupActions: setup.reduce((n, t) => n + t.actions, 0),
      wallMs: wall,
      cameraJumps: s.counters.cameraJumps,
      ...out.metrics,
    },
    checks: out.checks,
    tasks: out.tasks.map(({ value: _value, ...t }) => t),
    notes: [...out.notes, ...s.findings],
    scripted: s.scriptedSteps,
    pageErrors: s.pageErrors,
    evidence: (out.evidence ?? []).filter(Boolean).map((e) => `shots/${e.file}`),
    evidenceSha256: Object.fromEntries((out.evidence ?? []).filter(Boolean).map((e) => [`shots/${e.file}`, e.sha256])),
  };
  await s.close();
  // Files the probe produced, for the output probes (L1): the exported IFC and any drawing files.
  const files = { ...out.artifacts };
  const ifcText = out.exportText ?? s.lastExport?.text ?? null;
  if (ifcText) files.ifc = { name: `${probe.id}.ifc`, bytes: Buffer.from(ifcText, 'utf8') };
  if (saveArtifact) {
    const artifacts = {};
    for (const [kind, file] of Object.entries(files)) {
      if (file?.bytes) artifacts[kind] = await saveArtifact(probe.capability, file.name, file.bytes);
    }
    if (Object.keys(artifacts).length) {
      result.artifacts = artifacts;
      result.evidence.push(...Object.values(artifacts));
    }
  }
  return { result };
}

