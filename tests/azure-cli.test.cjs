'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { PlatformAdapter } = require('../lib/platform.cjs');
const TENANT = '11111111-1111-1111-1111-111111111111';
const helper = path.resolve(__dirname, '..', 'scripts', 'azure-cli.ps1');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '.sn-azure-helper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cache = path.join(root, 'tenants', createHash('sha256').update(TENANT).digest('hex'), 'azure-cli');
  const gate = path.join(root, 'continue.json');
  const script = path.join(root, 'mock-azure.cjs');
  await fs.writeFile(script, `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),mode=process.env.SN_AZURE_FIXTURE_MODE;
fs.appendFileSync(process.env.SN_AZURE_FIXTURE_CALLS,JSON.stringify({args,cache:process.env.AZURE_CONFIG_DIR})+'\\n');
if(mode==='failure'){console.error('PRIVATE_FIXTURE_DIAGNOSTIC');process.exitCode=1;}
else if(args[0]==='login'){
  console.error('To sign in, open https://microsoft.com/devicelogin');
  setTimeout(()=>{
    console.error('and enter the code ABCD12345 to authenticate.');
    const timer=setInterval(()=>{
      if(fs.existsSync(process.env.SN_AZURE_FIXTURE_GATE)){
        clearInterval(timer);console.log(JSON.stringify([{tenantId:'${TENANT}'}]));
      }
    },25);
  },50);
}else if(args[0]==='account'){
  console.log(JSON.stringify({accessToken:'header.'+Buffer.from(JSON.stringify({tid:'${TENANT}'})).toString('base64url')+'.fixture'}));
}else process.exitCode=2;
`);
  await fs.writeFile(path.join(root, 'az.cmd'), '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n');
  const calls = path.join(root, 'calls.jsonl');
  async function run(action, { mode = 'normal', onCode, blockedCache = false } = {}) {
    if (blockedCache) { await fs.mkdir(path.dirname(cache), { recursive: true }); await fs.writeFile(cache, 'not a directory'); }
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', helper, '-Action', action], {
      windowsHide: true,
      env: { ...process.env, [pathKey]: root + path.delimiter + process.env[pathKey], SN_AZURE_FIXTURE_MODE: mode, SN_AZURE_FIXTURE_GATE: gate, SN_AZURE_FIXTURE_CALLS: calls },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', codeSeen = false, callbackError;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (!codeSeen && stderr.includes('ABCD12345')) {
        codeSeen = true;
        Promise.resolve().then(() => onCode?.()).catch(error => { callbackError = error; }).finally(() => fs.writeFile(gate, '{}'));
      }
    });
    const timeout = setTimeout(() => {
      spawn('pwsh.exe', ['-NoProfile', '-Command', '$owned=@(' + child.pid + ');$queue=@(' + child.pid + ');while($queue.Count){$parent=$queue[0];$queue=@($queue|Select-Object -Skip 1);$children=@(Get-CimInstance Win32_Process -Filter (\'ParentProcessId=\'+$parent)|Select-Object -ExpandProperty ProcessId);$owned+=$children;$queue+=$children};foreach($id in @($owned|Sort-Object -Descending -Unique)){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}'], { windowsHide: true, stdio: 'ignore' });
    }, 20000);
    child.stdin.end(JSON.stringify({ tenant: TENANT, configDir: cache }));
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timeout));
    if (callbackError) throw callbackError;
    return { exitCode, stdout, stderr, codeSeen, data: JSON.parse(stdout.trim()) };
  }
  return { root, cache, gate, calls, run };
}

test('CDX helper streams a wrapped device code before login completes and reuses a secured cache', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  let receivedBeforeCompletion = false;
  const login = await f.run('Login', { onCode: async () => {
    await assert.rejects(fs.access(f.gate), { code: 'ENOENT' });
    receivedBeforeCompletion = true;
  } });
  assert.equal(receivedBeforeCompletion, true);
  assert.equal(login.exitCode, 0); assert.equal(login.codeSeen, true);
  assert.deepEqual(login.data, { ok: true, tenantId: TENANT });
  assert.match(login.stderr, /https:\/\/microsoft.com\/devicelogin.*ABCD12345/);
  assert.ok(!login.stdout.includes('ABCD12345'));
  const token = await f.run('Token');
  assert.equal(token.exitCode, 0); assert.equal(token.data.ok, true);
  assert.match(token.data.accessToken, /^header\..+\.fixture$/);
  const repeated = await f.run('Login'); assert.equal(repeated.exitCode, 0);
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls[0].args, ['login', '--tenant', TENANT, '--use-device-code', '--allow-no-subscriptions', '--output', 'json']);
  assert.ok(calls.every(call => call.cache === f.cache));
});

test('CDX cache failure has an actionable safe code and never starts Azure CLI', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const result = await f.run('Login', { blockedCache: true });
  assert.equal(result.exitCode, 1); assert.deepEqual(result.data, { ok: false, code: 'CACHE_ACCESS' });
  await assert.rejects(fs.access(f.calls), { code: 'ENOENT' });
});

test('CDX login failure does not expose raw CLI diagnostics', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), result = await f.run('Login', { mode: 'failure' });
  assert.equal(result.exitCode, 1); assert.equal(result.data.code, 'LOGIN_FAILED');
  assert.ok(!result.stdout.includes('PRIVATE_FIXTURE_DIAGNOSTIC')); assert.ok(!result.stderr.includes('PRIVATE_FIXTURE_DIAGNOSTIC'));
});

test('CDX adapter forwards split prompt chunks and verifies the returned tenant', async t => {
  const updates = [];
  const adapter = new PlatformAdapter({ runtimeHome: path.resolve(os.tmpdir(), '.sn-unused-adapter'), processRunner: async request => {
    if (request.action === 'Login') {
      request.onStderr('To sign in, open https://microsoft.com/device');
      request.onStderr('login and enter the code ');
      request.onStderr('ABCD12345 to authenticate.');
      return { stdout: JSON.stringify({ ok: true, tenantId: TENANT }), exitCode: 0 };
    }
    return { stdout: JSON.stringify({ ok: true, accessToken: 'header.' + Buffer.from(JSON.stringify({ tid: TENANT })).toString('base64url') + '.fixture' }), exitCode: 0 };
  }, fetchImpl: async () => new Response(JSON.stringify({ value: [{ id: TENANT, displayName: 'Fixture directory' }] })) });
  const result = await adapter.connectMicrosoft({ id: '22222222-2222-2222-2222-222222222222', tenantInput: TENANT }, value => updates.push(value));
  assert.equal(result.tenantId, TENANT);
  assert.equal(updates.filter(update => update.deviceCode === 'ABCD12345' && update.verificationUrl === 'https://microsoft.com/devicelogin').length, 1);
});
