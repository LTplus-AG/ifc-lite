/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import { createWindowsCpuFixture, literal } from './frame-gpu-cpu-fixture.mjs';
const unregister = register();
const { launchWindowsChrome, ChromeStartupError } = await (async () => {
  try {
    return await import('./frame-gpu-chrome.ts');
  } finally {
    await unregister();
  }
})();
// #6975: actual Windows CPU executable + canonical Job supervisor. No Chrome,
// GPU, browser input, or native timing admission is certified by these controls.
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'], { encoding: 'utf8', timeout: 10000 });
const provider = spawnSync('which', ['powershell.exe'], { encoding: 'utf8', timeout: 5000 });
const conversion = spawnSync('which', ['wslpath'], { encoding: 'utf8', timeout: 5000 });
const skip = probe.error || probe.status !== 0 || provider.status !== 0 || conversion.status !== 0
  ? 'Actual Windows CPU Job launcher controls unavailable; launcher qualification held' : false;
function ps(script, timeout = 15000) {
  const result = spawnSync(provider.stdout.trim(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';\n" + script, 'utf16le').toString('base64')],
  { encoding: 'utf8', timeout });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
function win(path) {
  const result = spawnSync(conversion.stdout.trim(), ['-w', path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function until(predicate, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(25); }
  assert.fail('Actual owned CPU fixture did not reach its asserted state');
}
const policy = { commandMs: 5000, startupMs: 2000, requestMs: 100, pollMs: 25,
  cleanupMs: 10000, jobRequestMs: 15000, lifetimeSeconds: 900, runBudgetMs: 600000 };
function records(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function identityPrelude() {
  return `Add-Type -Path ${literal(win(fileURLToPath(new URL('./frame-gpu-process-identity.cs', import.meta.url))))};`;
}
function exactAlive(identity) {
  const observed = JSON.parse(ps(`${identityPrelude()}[IfcProcessIdentity]::ObserveExact(${identity.pid},${literal(identity.created)})|ConvertTo-Json -Compress`));
  assert.ok(observed.state === 'live' || observed.state === 'exited' || observed.state === 'notFound');
  return observed.state === 'live';
}
function retireExact(identity) {
  const observed = JSON.parse(ps(`${identityPrelude()}[IfcProcessIdentity]::TerminateExact(${identity.pid},${literal(identity.created)},5000)|ConvertTo-Json -Compress`));
  assert.ok(observed.state === 'exited' || observed.state === 'notFound');
}
function fixture(mode = 'no-endpoint') {
  const root = mkdtempSync(join(tmpdir(), 'ifc-contained-launcher-')), ledger = join(root, 'ledger');
  mkdirSync(ledger);
  const cpu = createWindowsCpuFixture(mode, root);
  const { win: rootWin, exe } = cpu;
  const beforePath = process.env.PATH;
  const bin = join(root, 'bin'); mkdirSync(bin);
  return { root, ledger, rootWin, exe, bin, roots: () => cpu.roots(),
    owner: () => { const files = readdirSync(ledger).filter(x => x.endsWith('.owner.json'));return files.length ? JSON.parse(readFileSync(join(ledger, files.at(-1)), 'utf8')) : null; },
    installProvider(script) { writeFileSync(join(bin, 'powershell.exe'), '#!/usr/bin/python3\n' + script, { mode: 0o755 }); process.env.PATH = bin + ':' + beforePath; },
    installConversionFailure() { writeFileSync(join(bin, 'wslpath'), `#!/usr/bin/python3\nimport os,sys\nif sys.argv[1]=='-w' and sys.argv[-1]==${JSON.stringify(exe)}:sys.exit(9)\nos.execv(${JSON.stringify(conversion.stdout.trim())},[${JSON.stringify(conversion.stdout.trim())}]+sys.argv[1:])\n`, { mode: 0o755 });process.env.PATH=bin+':'+beforePath; },
    gatedSupervisor() {
      const prefix = `$self=[Diagnostics.Process]::GetCurrentProcess();$record=@{pid=$PID;created=$self.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress;[IO.File]::WriteAllText(${literal(rootWin+'\\supervisor.json.tmp')},$record);[IO.File]::Move(${literal(rootWin+'\\supervisor.json.tmp')},${literal(rootWin+'\\supervisor.json')});while(-not(Test-Path ${literal(rootWin+'\\release')})){Start-Sleep -Milliseconds 25};`;
      this.installProvider(`import os,sys,base64\nargs=sys.argv[1:]\nif '-EncodedCommand' in args:\n i=args.index('-EncodedCommand')+1;s=base64.b64decode(args[i]).decode('utf-16le')\n if 'frame-gpu-job-supervisor.ps1' in s:args[i]=base64.b64encode((${JSON.stringify(prefix)}+s).encode('utf-16le')).decode()\nos.execv(${JSON.stringify(provider.stdout.trim())},[${JSON.stringify(provider.stdout.trim())}]+args)\n`);
    },
    async cleanup() {
      process.env.PATH = beforePath;
      const retirement = { root, identities: [], supervisors: [], profiles: [], cleanupFailure: null };
      // This copied native Read source is independent of endpoint/no-start
      // inverse mutations. Unknown access/query/mismatched births fail cleanup.
      const observe = identity => {
        const observed = JSON.parse(ps(`Add-Type -Path ${literal(rootWin+'\\frame-gpu-process-identity.cs')};[IfcProcessIdentity]::Read(${identity.pid})|ConvertTo-Json -Compress`));
        assert.equal(observed.pid, identity.pid);
        assert.ok(observed.state === 'live' || observed.state === 'exited' || observed.state === 'notFound');
        if (observed.state !== 'notFound') assert.equal(observed.started, identity.created);
        return observed;
      };
      try {
        writeFileSync(join(root, 'release'), 'fixture teardown');
        const supervisors = records(join(root, 'supervisor.json'));
        for (const identity of supervisors) {
          await until(() => observe(identity).state !== 'live', 30000);
          retirement.supervisors.push({ identity, observed: observe(identity) });
        }
        const preparedRoots = [];
        const identities = new Set();
        for (const file of readdirSync(ledger).filter(file => file.endsWith('.job.json'))) {
          const token = file.slice(0, -'.job.json'.length);
          assert.match(token, /^[a-f0-9]{32}$/);
          const prepared = JSON.parse(readFileSync(join(ledger,file),'utf8'));
          assert.equal(prepared.version,1);
          assert.equal(prepared.owner.version,1);assert.equal(prepared.owner.token,token);
          assert.equal(prepared.owner.ledger,ledger);
          assert.equal(prepared.job.jobName, `Local\\ifclite-owned-${token}`);
          const identity = {pid:prepared.job.rootPid,created:prepared.job.rootCreated};
          assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
          assert.equal(typeof identity.created, 'string');
          const stamp = BigInt(identity.created);
          assert.ok(stamp > 0n);
          assert.equal(stamp.toString(), identity.created, 'Prepared native stamp is canonical positive decimal');
          const key = `${identity.pid}:${identity.created}`;
          assert.equal(identities.has(key),false,'Duplicate durable prepared root birth identity');
          identities.add(key);preparedRoots.push({token,identity});
        }
        // A root that fails before publishing a fixture record still belongs
        // to this durable Job. Observe every prepared birth, independently.
        for (const {token,identity} of preparedRoots) {
          if (observe(identity).state === 'live') retireExact(identity);
          const observed = observe(identity);
          retirement.identities.push({ token, identity, observed });
          assert.notEqual(observed.state, 'live');
        }
        for (const file of readdirSync(ledger).filter(x => x.endsWith('.owner.json'))) {
          const owner = JSON.parse(readFileSync(join(ledger, file), 'utf8'));
          if (existsSync(owner.profileWsl)) {
            const archive = join(root, 'retained-profiles', owner.token);
            cpSync(owner.profileWsl, archive, { recursive: true });
            retirement.profiles.push({ owner, archive });
          }
        }
        // Publish complete observations before removing any fixture profile.
        writeFileSync(join(root, 'retirement.receipt.json'), JSON.stringify(retirement));
        for (const { owner } of retirement.profiles) rmSync(owner.profileWsl, { recursive: true });
      } catch (error) {
        retirement.cleanupFailure = String(error);
        writeFileSync(join(root, 'retirement.receipt.json'), JSON.stringify(retirement));
        throw error;
      }
      // Root/ledger/compiler/native receipts remain for durable qualification.

    } };
}
async function failure(exe, options) {
  try { await launchWindowsChrome(exe, 2, options); assert.fail('Expected a finite startup refusal'); }
  catch (error) { assert.ok(error instanceof ChromeStartupError);return error; }
}
for (const kind of ['missing-executable', 'non-executable-file']) {
  test(`#6975 actual Win32 ${kind} preserves constructor proof and cleans no-root profiles`, { skip, timeout: 90000 }, async context => {
    const f = fixture(); const exe = join(f.root, kind);
    if (kind === 'non-executable-file') writeFileSync(exe, 'not a Windows executable');
    try {
      const error = await failure(exe, { ...policy, ledger: f.ledger });
      assert.equal(error.startupFailures.length, 2);
      for (const receipt of error.startupFailures) {
        const terminal = receipt.jobFailure.packets.at(-1);
        assert.match(terminal.failure.error, /Create suspended root/);
        assert.equal(terminal.event, 'terminal');assert.equal(terminal.failure.startupCleanupProved, true);
        assert.equal(terminal.failure.jobName, `Local\\ifclite-owned-${receipt.owner.token}`);
        assert.equal(terminal.failure.rootPid, 0);assert.equal(terminal.failure.rootCreated, null);
        assert.equal(terminal.failure.resumed, false);assert.deepEqual(receipt.jobFailure.retirement, { code: 1, signal: null });
        assert.equal(receipt.cleanupError, null);assert.equal(existsSync(receipt.profileWsl), false);
      }
      assert.equal(f.roots().length, 0);context.diagnostic(JSON.stringify(error.startupFailures));
    } finally { await f.cleanup(); }
  });
}
test('#6975 actual CPU endpoint failures retire both admitted Jobs before bounded retry', { skip, timeout: 90000 }, async context => {
  const f = fixture();
  try {
    const error = await failure(f.exe, { ...policy, ledger: f.ledger });
    assert.equal(error.startupFailures.length, 2);assert.equal(f.roots().length, 2);
    for (const receipt of error.startupFailures) {
      assert.equal(receipt.cleanupError, null);assert.equal(existsSync(receipt.profileWsl), false);
      const disposed = JSON.parse(readFileSync(join(f.ledger, `${receipt.owner.token}.disposed.json`), 'utf8'));
      assert.ok(disposed.packets.some(p => p.event === 'disposed' && p.activeProcesses === 0));
      assert.ok(disposed.packets.some(p => p.event === 'terminal' && p.ok === true));
    }
    assert.ok(f.roots().every(identity => !exactAlive(identity)));context.diagnostic(JSON.stringify(error.startupFailures));
  } finally { await f.cleanup(); }
});
test('#6975 actual CPU endpoint binds TCP listener to exact contained root before disposal', { skip, timeout: 60000 }, async context => {
  const f = fixture('endpoint');let session;
  try {
    session = await launchWindowsChrome(f.exe, 1, { ...policy, ledger: f.ledger });
    assert.equal(f.roots().length, 1);assert.equal(session.job.prepared.job.rootPid, f.roots()[0].pid);
    assert.equal(await session.dispose(), null);assert.equal(exactAlive(f.roots()[0]), false);
    context.diagnostic(JSON.stringify({ prepared: session.job.prepared, packets: session.job.controller.receipts }));
  } finally { if (session) { const error = await session.dispose();if (error) console.error(error); }await f.cleanup(); }
});
test('#6975 actual foreign HTTP endpoint cannot substitute contained CPU root ownership', { skip, timeout: 60000 }, async () => {
  const f = fixture();const server = createServer((_request,response) => {response.writeHead(200);response.end('{}');});
  const starting = failure(f.exe, { ...policy, ledger: f.ledger });
  try {
    await until(() => f.roots().length > 0);
    await new Promise((resolve,reject) => {server.once('error',reject);server.listen(f.roots()[0].port,'127.0.0.1',resolve);});
    const error = await starting;
    assert.equal(error.startupFailures.length, 2);
    const endpointRefusal = error.startupFailures.some(r => /endpoint|TCP|owned|listener/i.test(r.error));
    assert.equal(endpointRefusal, true);
    assert.ok(f.roots().every(identity => !exactAlive(identity)));
  } finally { await starting;await new Promise(resolve => server.close(resolve));await f.cleanup(); }
});
test('#6975 actual acknowledged CPU root abort retires Job and exclusive profile', { skip, timeout: 60000 }, async () => {
  const f = fixture();const abort = new AbortController();
  const starting = failure(f.exe, { ...policy, ledger: f.ledger, signal: abort.signal, startupMs: 15000 });
  try {
    await until(() => f.roots().length === 1);abort.abort(Error('actual CPU root abort'));
    const error = await starting;assert.equal(error.startupFailures.length, 1);assert.equal(error.receipt.cleanupError, null);
    assert.equal(existsSync(error.receipt.profileWsl), false);assert.equal(exactAlive(f.roots()[0]), false);
  } finally { abort.abort(Error('fixture teardown'));await starting;await f.cleanup(); }
});
test('#6975 changed marker retires the known CPU Job but retains profile and prohibits retry', { skip, timeout: 60000 }, async context => {
  const f=fixture();const starting=failure(f.exe,{...policy,ledger:f.ledger,startupMs:15000});
  try {
    await until(()=>f.roots().length===1);const owner=f.owner();assert.ok(owner);
    writeFileSync(join(owner.profileWsl,'.ifclite-frame-owner.json'),'deliberately changed after acknowledged CPU birth');
    const error=await starting;assert.equal(error.startupFailures.length,1);assert.ok(error.receipt.cleanupError);
    assert.equal(existsSync(owner.profileWsl),true);assert.equal(exactAlive(f.roots()[0]),false);
    assert.equal(existsSync(join(f.ledger,`${owner.token}.disposed.json`)),false);context.diagnostic(JSON.stringify(error.receipt));
  } finally {await starting;await f.cleanup();}
});
test('#6975 abort before actual supervisor preparation retains unknown profile and prohibits retry', { skip, timeout: 90000 }, async context => {
  const f = fixture();f.gatedSupervisor();const abort = new AbortController();
  const starting = failure(f.exe, { ...policy, ledger: f.ledger, signal: abort.signal });
  try {
    await until(() => existsSync(join(f.root,'supervisor.json')));assert.equal(f.roots().length, 0);
    abort.abort(Error('pre-preparation abort'));writeFileSync(join(f.root,'release'),'release to canonical suspended-root refusal');
    const error = await starting;assert.equal(error.startupFailures.length, 1);
    assert.ok(error.receipt.cleanupError);assert.equal(existsSync(error.receipt.profileWsl), true);
    assert.equal(f.roots().length, 0);context.diagnostic(JSON.stringify(error.receipt));
  } finally { abort.abort(Error('fixture teardown'));await starting;await f.cleanup(); }
});
test('#6975 actual supervisor exit without a terminal proof retains profile and forbids retry', { skip, timeout: 60000 }, async context => {
  const f=fixture();
  f.installProvider(`import os,sys,base64\nargs=sys.argv[1:]\nif '-EncodedCommand' in args:\n i=args.index('-EncodedCommand')+1;s=base64.b64decode(args[i]).decode('utf-16le')\n if 'frame-gpu-job-supervisor.ps1' in s:args[i]=base64.b64encode('exit 7'.encode('utf-16le')).decode()\nos.execv(${JSON.stringify(provider.stdout.trim())},[${JSON.stringify(provider.stdout.trim())}]+args)\n`);
  try {
    const error=await failure(f.exe,{...policy,ledger:f.ledger});assert.equal(error.startupFailures.length,1);
    assert.ok(error.receipt.cleanupError);assert.equal(existsSync(error.receipt.profileWsl),true);
    assert.deepEqual(error.receipt.jobFailure.packets,[]);assert.deepEqual(error.receipt.jobFailure.retirement,{code:7,signal:null});assert.equal(error.receipt.jobFailure.supervisorNoStart,null);
    assert.equal(f.roots().length,0);context.diagnostic(JSON.stringify(error.receipt));
  } finally {await f.cleanup();}
});
test('#6975 actual mapping refusal before Job spawn cleans allocation without fabricated spawn receipts', { skip, timeout: 60000 }, async () => {
  const f = fixture();f.installConversionFailure();
  try {
    const error = await failure(f.exe, { ...policy, ledger: f.ledger });
    assert.equal(error.startupFailures.length, 2);assert.equal(f.roots().length, 0);
    for (const receipt of error.startupFailures) {assert.match(receipt.error,/wslpath/);assert.equal(receipt.jobFailure,undefined);assert.equal(receipt.cleanupError,null);assert.equal(existsSync(receipt.profileWsl),false);}
  } finally { await f.cleanup(); }
});
// #7180: preserve actual POSIX supervisor OS-error coverage independently of
// Windows availability. Only path-mapping commands are fixture providers;
// powershell.exe itself is genuinely missing or lacks execute permission.
function noStartFixture(code) {
  const root=mkdtempSync(join(tmpdir(),'ifc-supervisor-no-start-')),bin=join(root,'bin');
  mkdirSync(bin);mkdirSync(join(root,'Temp'));const before=process.env.PATH;
  writeFileSync(join(bin,'cmd.exe'),'#!/usr/bin/python3\nprint("C:\\\\ifclite-fixture")\n',{mode:0o755});
  const pathProvider=`#!/usr/bin/python3
import sys,os
root=${JSON.stringify(root)}
if sys.argv[1]=='-u':print(os.path.join(root,'Temp'))
else:
 path=sys.argv[-1]
 relative=os.path.relpath(path,root) if path.startswith(root+os.sep) else 'source'+path
 print('C:'+chr(92)+'ifclite-fixture'+chr(92)+relative.replace('/',chr(92)))
`;
  writeFileSync(join(bin,'wslpath'),pathProvider,{mode:0o755});
  // Delegate the one actual Windows allocation, then remove execute capability
  // before launchOwnedJob's own OS spawn. No fabricated allocation/errno.
  writeFileSync(join(bin,'powershell.exe'), `#!/usr/bin/python3
import sys,os,subprocess,json
root=${JSON.stringify(root)}
run=subprocess.run([${JSON.stringify(provider.stdout.trim())}]+sys.argv[1:],capture_output=True,timeout=4)
open(os.path.join(root,'allocation.native.stdout.log'),'wb').write(run.stdout)
open(os.path.join(root,'allocation.native.stderr.log'),'wb').write(run.stderr)
open(os.path.join(root,'allocation.native.retirement.json'),'w').write(json.dumps({'code':run.returncode}))
sys.stdout.buffer.write(run.stdout)
sys.stderr.buffer.write(run.stderr)
if run.returncode==0:
 if ${JSON.stringify(code)}=='ENOENT':os.unlink(sys.argv[0])
 else:os.chmod(sys.argv[0],0o644)
sys.exit(run.returncode)
`, {mode:0o755});
  process.env.PATH=bin;
  return {root,restore(){process.env.PATH=before;}};
}
for (const code of ['ENOENT','EACCES']) {
  test(`#7180 actual supervisor ${code} no-spawn cleanup retains primary native error`, {skip,timeout:60000}, async context => {
    const f=noStartFixture(code);
    try {
      let error;
      try { await launchWindowsChrome('/deliberately-unused-root.exe',1,policy);assert.fail('Expected actual supervisor OS refusal'); }
      catch (caught) {assert.ok(caught instanceof ChromeStartupError);error=caught;}
      writeFileSync(join(f.root,'no-start.receipt.json'),JSON.stringify(error.startupFailures));
      assert.equal(error.startupFailures.length,1,'One native allocation followed by one genuine supervisor OS refusal');
      assert.deepEqual(JSON.parse(readFileSync(join(f.root,'allocation.native.retirement.json'),'utf8')),{code:0});
      const allocation=JSON.parse(readFileSync(join(f.root,'allocation.native.stdout.log'),'utf8').trim());
      assert.ok(Number.isSafeInteger(allocation.port) && allocation.port>0 && allocation.port<=65535);
      assert.deepEqual({address:allocation.address,exclusive:allocation.exclusive,stopped:allocation.stopped},{address:'127.0.0.1',exclusive:true,stopped:true});
      for(const receipt of error.startupFailures){
        assert.match(receipt.error,new RegExp(`spawn powershell.exe ${code}`));
        assert.equal(receipt.cleanupError,null);assert.equal(existsSync(receipt.profileWsl),false);
        assert.deepEqual(receipt.jobFailure.packets,[]);
        assert.deepEqual(receipt.jobFailure.retirement,{code:code==='ENOENT'?-2:-13,signal:null});
        assert.deepEqual(receipt.jobFailure.supervisorNoStart,{executable:'powershell.exe',syscall:'spawn powershell.exe',code,errno:code==='ENOENT'?-2:-13});
      }
      assert.deepEqual(readdirSync(join(f.root,'Temp')),[],'No actual allocated profile remains');
      writeFileSync(join(f.root,'no-start.receipt.json'),JSON.stringify(error.startupFailures));
      context.diagnostic(JSON.stringify(error.startupFailures));
    } finally {f.restore();}
  });
}
