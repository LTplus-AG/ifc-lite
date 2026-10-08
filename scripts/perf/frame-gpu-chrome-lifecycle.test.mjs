/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
const { launchWindowsChrome, ChromeStartupError } = await tsImport('./frame-gpu-chrome.ts', import.meta.url);
/** #7036: actual owned subprocess/filesystem behavior; these providers never launch Chrome/GPU. */
function fixture(mode) {
    const root = mkdtempSync(join(tmpdir(), '7036-lifecycle-')), bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'Temp'));
    const scripts = {
        'cmd.exe': `import os\nprint(os.environ['IFC_CHROME_FIXTURE_ROOT'])`,
        wslpath: `import sys,os\nif sys.argv[1]=='-w' and os.environ['IFC_CHROME_FIXTURE_MODE']=='conversion-fail':sys.exit(9)\nprint(sys.argv[-1].replace('\\\\','/'))`,
        'chrome-fixture': `import os,sys,json,time,signal,http.server\na=dict(x[2:].split('=',1) for x in sys.argv[1:] if x.startswith('--') and '=' in x)\np=a['user-data-dir'];open(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'allocations.jsonl'),'a').write(json.dumps({'pid':os.getpid(),'profile':p})+'\\n')\nif os.environ['IFC_CHROME_FIXTURE_MODE'] in ('delayed-no-endpoint','hung-cleanup'):time.sleep(.4)\nif os.environ['IFC_CHROME_FIXTURE_MODE'] in ('pre-owner-abort','pre-owner-wait'):\n while not os.path.exists(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'ack-release')):time.sleep(.01)\nopen(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'launches'),'a').write(p+'\\n')\nopen(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'identities.jsonl'),'a').write(json.dumps({'pid':os.getpid(),'profile':p})+'\\n')\nowner=os.path.join(p,'owner.json');open(owner+'.tmp','w').write(json.dumps({'pid':os.getpid(),'profile':p}));os.replace(owner+'.tmp',owner)\nif os.environ['IFC_CHROME_FIXTURE_MODE']=='wrong-endpoint':\n class Handler(http.server.BaseHTTPRequestHandler):\n  def do_GET(self):\n   open(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'responses'),'a').write('200\\n');self.send_response(200);self.end_headers()\n  def log_message(self,*args):pass\n http.server.HTTPServer(('127.0.0.1',int(a['remote-debugging-port'])),Handler).serve_forever()\nelse:\n while True:time.sleep(.01)`,
        'powershell.exe': `import os,sys,re,base64,json,signal,time\ns=base64.b64decode(sys.argv[-1]).decode('utf-16le');p=re.search(r"\\$profile='((?:[^']|'')*)'",s).group(1).replace("''", "'")\nif 'Get-NetTCPConnection' in s:\n open(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'ownership-refusals'),'a').write(p+'\\n');sys.exit(9)\nif os.environ['IFC_CHROME_FIXTURE_MODE']=='hung-cleanup':time.sleep(5)\nf=os.path.join(p,'owner.json')\nif os.environ['IFC_CHROME_FIXTURE_MODE'] in ('pre-owner-abort','pre-owner-wait'):\n open(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'cleanup-entered'),'w').write(p)\n if os.environ['IFC_CHROME_FIXTURE_MODE']=='pre-owner-wait':open(os.path.join(os.environ['IFC_CHROME_FIXTURE_ROOT'],'ack-release'),'w').write(p)\nrequest=re.search(r'Invoke-OwnedChromeCleanup -Profile \\$profile -DeadlineMs (\\d+)',s)\nif request:\n budget=max(.001,(int(request.group(1))-1000)/1000);until=time.monotonic()+budget\n while not os.path.exists(f) and time.monotonic()<until:time.sleep(.01)\n if not os.path.exists(f):sys.exit(11)\nif os.path.exists(f):\n try:\n  pid=json.load(open(f))['pid'];args=open('/proc/'+str(pid)+'/cmdline','rb').read().split(b'\\0')\n  if ('--user-data-dir='+p).encode() in args:os.kill(pid,signal.SIGTERM)\n  elif any(args):sys.exit(10)\n except (ProcessLookupError,FileNotFoundError):pass\n`,
    };
    for (const [name, body] of Object.entries(scripts))
        writeFileSync(join(bin, name), '#!/usr/bin/env python3\n' + body + '\n', { mode: 0o755 });
    const before = { PATH: process.env.PATH, root: process.env.IFC_CHROME_FIXTURE_ROOT, mode: process.env.IFC_CHROME_FIXTURE_MODE };
    process.env.PATH = bin + ':' + before.PATH;
    process.env.IFC_CHROME_FIXTURE_ROOT = root;
    process.env.IFC_CHROME_FIXTURE_MODE = mode;
    return { root, exe: join(bin, 'chrome-fixture'), allocations: () => existsSync(join(root, 'allocations.jsonl')) ? readFileSync(join(root, 'allocations.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [], identities: () => existsSync(join(root, 'identities.jsonl')) ? readFileSync(join(root, 'identities.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [], profiles: () => readdirSync(join(root, 'Temp')).filter(x => x.slice(0,8)==='ifclite-').map(x => join(root, 'Temp', x)), cleanup() {
            // The startup witness may fail before owner.json is acknowledged. The
            // separate allocation journal still permits exact owned-child retirement.
            const allocations = existsSync(join(root, 'allocations.jsonl')) ? readFileSync(join(root, 'allocations.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
            for (const owner of allocations) {
                try {
                    const args = readFileSync(`/proc/${owner.pid}/cmdline`).toString().split('\0');
                    if (args.some(argument=>argument===`--user-data-dir=${owner.profile}`))
                        process.kill(owner.pid, 'SIGTERM');
                    else if (args.some(Boolean))
                        throw Error('Fixture cleanup refused an unknown PID owner');
                }
                catch (error) {
                    if (!new Set(['ESRCH', 'ENOENT']).has(error.code))
                        throw error;
                }
            }
            process.env.PATH = before.PATH;
            for (const [key, value] of [['IFC_CHROME_FIXTURE_ROOT', before.root], ['IFC_CHROME_FIXTURE_MODE', before.mode]]) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
            rmSync(root, { recursive: true, force: true });
        } };
}
function ownedProcessLive(owner) { try {
    return readFileSync(`/proc/${owner.pid}/cmdline`).toString().split('\0').some(argument=>argument===`--user-data-dir=${owner.profile}`);
}
catch (error) {
    if (error.code === 'ENOENT')
        return false;
    throw error;
} }
const policy = { commandMs: 1000, startupMs: 150, requestMs: 40, pollMs: 10, cleanupMs: 1000 };
// #7180: these controls require real provider acknowledgement before asserting
// ownership. Share the existing endpoint-control budget; production stays unchanged.
const ownedStartupPolicy = { ...policy, startupMs: 2000 };
test('#7036 failed startup cleans its actual allocated owner/profile and retains all failed-attempt receipts', async () => {
    // #7180: force real interpreter/provider startup beyond the old 150ms
    // budget. This fixture-only allowance leaves production deadlines intact.
    const f = fixture('delayed-no-endpoint');
    try {
        let failure;
        try {
            await launchWindowsChrome(f.exe, 2, ownedStartupPolicy);
        }
        catch (error) {
            failure = error;
        }
        assert.ok(failure instanceof ChromeStartupError);
        assert.equal(failure.startupFailures.length, 2);
        for (const receipt of failure.startupFailures) {
            assert.equal(receipt.cleanupError, null);
            assert.equal(existsSync(receipt.profileWsl), false);
        }
        assert.equal(f.profiles().length, 0);
        assert.equal(f.identities().length, 2);
        assert.ok(f.identities().every(owner => !ownedProcessLive(owner)), 'Original fixture PIDs must be terminated before successful cleanup');
    }
    finally {
        f.cleanup();
    }
});
test('#7036 hanging cleanup remains an explicit known owner and prohibits another startup', async () => {
    const f = fixture('hung-cleanup');
    try {
        let failure;
        try {
            await launchWindowsChrome(f.exe, 3, { ...ownedStartupPolicy, cleanupMs: 100 });
        }
        catch (error) {
            failure = error;
        }
        assert.ok(failure instanceof ChromeStartupError);
        assert.equal(failure.startupFailures.length, 1);
        assert.ok(failure.receipt.cleanupError);
        assert.equal(existsSync(failure.receipt.profileWsl), true);
        assert.equal(f.identities().length, 1, 'Hanging cleanup requires an acknowledged fixture owner');
        assert.equal(readFileSync(join(f.root, 'launches'), 'utf8').trim().split('\n').length, 1);
    }
    finally {
        f.cleanup();
    }
});
test('#7036 abort while actual owned subprocess is starting does not abandon its allocated profile', async () => {
    const f = fixture('no-endpoint'), abort = new AbortController();
    const starting = launchWindowsChrome(f.exe, 1, { ...policy, startupMs: 15000, signal: abort.signal }).then(value => ({ value }), error => ({ error }));
    try {
        const deadline = Date.now() + 10000;
        while (!f.profiles().some(p => existsSync(join(p, 'owner.json')))) {
            assert.ok(Date.now() < deadline, 'Actual owned fixture must start before abort witness');
            await sleep(10);
        }
        abort.abort(new Error('fixture abort'));
        const result = await starting;
        assert.ok(result.error instanceof ChromeStartupError);
        assert.equal(result.error.receipt.cleanupError, null);
        assert.equal(result.error.startupFailures.length, 1);
        assert.equal(f.profiles().length, 0);
        assert.equal(f.identities().length, 1);
        assert.ok(f.identities().every(owner => !ownedProcessLive(owner)));
    }
    finally {
        if (!abort.signal.aborted)
            abort.abort(new Error('fixture teardown'));
        await starting;
        f.cleanup();
    }
});
test('#7036 a responding endpoint without proved process/profile ownership never returns a browser', async () => {
    const f = fixture('wrong-endpoint');
    try {
        await assert.rejects(launchWindowsChrome(f.exe, 1, ownedStartupPolicy), error => { assert.ok(error instanceof ChromeStartupError); assert.equal(error.receipt.cleanupError, null, JSON.stringify(error.receipt)); return true; });
        assert.equal(f.profiles().length, 0);
        assert.ok(readFileSync(join(f.root, 'responses'), 'utf8').trim().split('\n').every(status=>Number(status)===200));
        assert.ok(readFileSync(join(f.root, 'ownership-refusals'), 'utf8').trim(), 'Actual ownership refusal provider must have run after a responding endpoint');
        assert.ok(f.identities().every(owner => !ownedProcessLive(owner)));
    }
    finally {
        f.cleanup();
    }
});
test('#7036 failure after profile allocation but before browser spawn removes the actual directory', async () => {
    const f = fixture('conversion-fail');
    try {
        await assert.rejects(launchWindowsChrome(f.exe, 1, policy), error => error instanceof ChromeStartupError && error.receipt.profileWin === null && error.receipt.cleanupError === null && !existsSync(error.receipt.profileWsl));
        assert.equal(f.profiles().length, 0);
        assert.equal(existsSync(join(f.root, 'launches')), false);
    }
    finally {
        f.cleanup();
    }
});

// #7180: journal allocation is deliberately earlier than acknowledged ownership.
for (const cleanupMs of [250, 2000]) {
 test(`#7036 abort before provider ownership ${cleanupMs===250?'refuses unknown retirement':'waits for observed root retirement'}`, async()=>{
  const f=fixture(cleanupMs===250?'pre-owner-abort':'pre-owner-wait'), abort=new AbortController();
  const starting=launchWindowsChrome(f.exe,3,{...policy,startupMs:15000,cleanupMs,signal:abort.signal}).then(value=>({value}),error=>({error}));
  try {
   const deadline=Date.now()+10000;
   while(!f.allocations().length){assert.ok(Date.now()<deadline,'Actual child allocation must precede abort');await sleep(5);}
   assert.equal(f.identities().length,0,'Abort must precede owner acknowledgement');
   abort.abort(Error('pre-owner abort'));
   const result=await starting;assert.ok(result.error instanceof ChromeStartupError);
   assert.equal(result.error.startupFailures.length,1,'Unproved owner or abort must prohibit another launch');
   assert.equal(existsSync(join(f.root,'cleanup-entered')),true,'Actual cleanup provider must start before acknowledgement release');
   const receipt=result.error.receipt;
   console.info(JSON.stringify({control:'pre-owner-abort',cleanupMs,receipt,allocations:f.allocations(),acknowledged:f.identities(),live:f.allocations().map(owner=>({ ...owner,live:ownedProcessLive(owner)}))}));
   if(cleanupMs===250){
    assert.equal(existsSync(join(f.root,'ack-release')),false,'Unknown owner must remain blocked until finally retirement');
    assert.ok(receipt.cleanupError,'Unknown initial absence must refuse cleanup');
    assert.equal(existsSync(receipt.profileWsl),true,'Unproved allocated profile must remain');
    assert.ok(f.allocations().some(ownedProcessLive),'Actual starting child remains recorded for finally retirement');
   } else {
    assert.equal(receipt.cleanupError,null);assert.equal(existsSync(receipt.profileWsl),false);
    assert.equal(f.identities().length,1);assert.ok(f.identities().every(owner=>!ownedProcessLive(owner)));
   }
  } finally {
   if(!abort.signal.aborted)abort.abort(Error('fixture teardown'));
   await starting;const allocated=f.allocations();f.cleanup();
   const retirementDeadline=Date.now()+1000;
   while(allocated.some(ownedProcessLive)&&Date.now()<retirementDeadline)await sleep(5);
   assert.ok(allocated.every(owner=>!ownedProcessLive(owner)),'Finally must retire every exact allocated fixture child');
   console.info(JSON.stringify({control:'pre-owner-finally',cleanupMs,retired:allocated.map(owner=>({...owner,live:ownedProcessLive(owner)}))}));
  }
 });
}
