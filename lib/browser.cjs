'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findEdge } = require('./dependencies.cjs');
const { setTimeout: sleep } = require('node:timers/promises');
const { pdi, error } = require('./profiles.cjs');
const SYSID = /^[0-9a-f]{32}$/;
function fail(code) {
  const messages = {
    BROWSER_PROTOCOL: 'The isolated browser returned an invalid protocol response.',
     BROWSER_NAVIGATING: 'The page execution context changed during normal navigation.',
    BROWSER_NETWORK: 'The isolated browser request timed out or could not reach the instance.',
    BROWSER_START: 'The isolated Edge browser could not start. No credentials were submitted.',
    BROWSER_SCOPE: 'The browser attempted to leave the selected instance or an unsupported request route. The request was blocked.',
    BROWSER_INTERACTIVE: 'Normal login is blocked by MFA/SSO, a redirect/popup, unsupported login navigation or an attended step. No successful admin login was inferred.',
    BROWSER_LOGIN_FAILED: 'The normal first-party login did not establish the requested admin session.',
    BROWSER_ACTOR: 'The isolated browser actor does not match the exact requested admin, or impersonation state is unknown/active.',
    BROWSER_CLEANUP: 'The owned isolated browser could not be closed or its local profile could not be removed.',
    CANCELLED: 'The isolated browser operation was cancelled.'
  };
  return error(messages[code] || messages.BROWSER_PROTOCOL, code in messages ? code : 'BROWSER_PROTOCOL', 409);
}
function abort(signal) { if (signal?.aborted) throw fail('CANCELLED'); }
function actorState(state, profile) {
  if (!state || state.origin !== profile.pdiUrl || !SYSID.test(state.actorId || '') || state.actorName !== profile.adminUser || state.impersonating !== false || state.hasToken !== true) throw fail('BROWSER_ACTOR');
  return Object.freeze({ sysId: state.actorId, userName: state.actorName, authMethod: 'isolated-browser-session', impersonating: false });
}
async function connectCdp(url) {
  const socket = new WebSocket(url), pending = new Map(), listeners = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(fail('BROWSER_NETWORK')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(fail('BROWSER_NETWORK')); }, { once: true });
  });
  const rejectPending = () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(fail('BROWSER_PROTOCOL')); } pending.clear(); };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  socket.addEventListener('message', event => {
    let message;
    try { if (String(event.data).length > 2 * 1024 * 1024) throw fail('BROWSER_PROTOCOL'); message = JSON.parse(event.data); }
    catch { rejectPending(); return; }
    if (!message.id) { listeners.get(message.method)?.(message.params); return; }
    const value = pending.get(message.id);
    if (!value) return;
    pending.delete(message.id); clearTimeout(value.timer);
    if (message.error) value.reject(fail(/Execution context was destroyed|Cannot find (?:default execution )?context|Cannot find context with specified id/i.test(message.error.message||'')?'BROWSER_NAVIGATING':'BROWSER_PROTOCOL')); else value.resolve(message.result);
  });
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(fail('BROWSER_NETWORK')); }, 30000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { clearTimeout(timer); pending.delete(id); reject(fail('BROWSER_PROTOCOL')); }
      });
    },
    on(method, callback) { listeners.set(method, callback); },
    close() { socket.close(); rejectPending(); }
  };
}
class IsolatedAdminBrowser {
  constructor({ runtimeHome, profile, signal, fetchImpl = global.fetch, spawnImpl = spawn, connectImpl = connectCdp, loginTimeoutMs = 25000 } = {}) {
    this.profile = Object.freeze({ ...profile, pdiUrl: pdi(profile.pdiUrl) });
    this.runtimeHome = runtimeHome; this.signal = signal; this.fetchImpl = fetchImpl; this.spawnImpl = spawnImpl; this.connectImpl = connectImpl; this.loginTimeoutMs = loginTimeoutMs;
    this.child = null; this.cdp = null; this.browserCdp = null; this.directory = null; this.exited = false;
    this.loginArmed = false; this.readUrls = new Set(); this.scopeFailure = null; this.protocolFailure = null; this.actor = null;
  }
  check() { abort(this.signal); if (this.protocolFailure) throw this.protocolFailure; if (this.scopeFailure) throw this.scopeFailure; }
  permits(request) {
    let url; try { url = new URL(request.url); } catch { return false; }
    if (url.origin !== this.profile.pdiUrl || url.username || url.password || Object.keys(request.headers || {}).some(name => /^(x-http-method-override|x-http-method|x-method-override)$/i.test(name))) return false;
    if (request.method === 'POST') return this.loginArmed && url.pathname === '/login.do';
    if (request.method !== 'GET') return false;
    if (url.pathname.startsWith('/api/')) return this.readUrls.has(url.href);
    if (/\.(?:js|jsx|jsdbx|css|cssx|cssdbx|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i.test(url.pathname)) return true;
    return ['/', '/login.do', '/sys_user_list.do', '/navpage.do', '/nav_to.do', '/welcome.do', '/home.do', '/login_redirect.do', '/now/nav/ui/classic'].includes(url.pathname) || url.pathname.startsWith('/now/nav/ui/classic/');
  }
  async start() {
    this.check();
    const parent = path.join(this.runtimeHome, 'browsers');
    await fs.mkdir(parent, { recursive: true });
    this.directory = await fs.mkdtemp(path.join(parent, 'admin-'));
    await fs.mkdir(path.join(this.directory, 'Default'));
    await fs.writeFile(path.join(this.directory, 'Default', 'Preferences'), JSON.stringify({credentials_enable_service:false,profile:{password_manager_enabled:false},autofill:{profile_enabled:false,credit_card_enabled:false}}));
    const edge=findEdge();if(!edge)throw fail('BROWSER_START');
    this.child = this.spawnImpl(edge, ['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-sync','--disable-crash-reporter','--disable-save-password-bubble','--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1', '--user-data-dir=' + this.directory, 'about:blank'], { windowsHide: true, shell: false, stdio: 'ignore' });
    this.child.once('exit', () => { this.exited = true; });
    this.child.once('error', () => { this.protocolFailure = fail('BROWSER_START'); });
    let port, browserPath;
    for (let attempt = 0; attempt < 80; attempt++) {
      this.check(); if (this.exited) throw fail('BROWSER_START');
      try {
        const lines = (await fs.readFile(path.join(this.directory, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/), candidatePort = Number(lines[0]);
        if (Number.isInteger(candidatePort) && candidatePort > 0 && candidatePort <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1] || '')) { port = candidatePort; browserPath = lines[1]; break; }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await sleep(150);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath || '')) throw fail('BROWSER_START');
    const response = await this.fetchImpl('http://127.0.0.1:' + port + '/json/list', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw fail('BROWSER_PROTOCOL');
    const targets = await response.json(), pages = targets.filter(target => target.type === 'page' && target.url === 'about:blank');
    if (pages.length !== 1) throw fail('BROWSER_PROTOCOL');
    this.pageId = pages[0].id;
    const debuggerUrl = new URL(pages[0].webSocketDebuggerUrl);
    if (debuggerUrl.protocol !== 'ws:' || debuggerUrl.hostname !== '127.0.0.1' || Number(debuggerUrl.port) !== port || !/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(debuggerUrl.pathname)) throw fail('BROWSER_PROTOCOL');
    this.debuggerUrl = debuggerUrl.href;
    this.browserCdp = await this.connectImpl('ws://127.0.0.1:' + port + browserPath);
    this.browserCdp.on('Target.attachedToTarget', params => {
      const command = params.targetInfo.targetId === this.pageId ? this.browserCdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId) : this.browserCdp.send('Target.closeTarget', { targetId: params.targetInfo.targetId });
      if (params.targetInfo.targetId !== this.pageId && params.targetInfo.type === 'page') this.scopeFailure = fail('BROWSER_INTERACTIVE');
      command.catch(() => { this.protocolFailure = fail('BROWSER_PROTOCOL'); });
    });
    this.cdp = await this.connectImpl(this.debuggerUrl);
    this.cdp.on('Fetch.requestPaused', params => {
      const permitted = this.permits(params.request);
      if (permitted && params.request.method === 'POST') this.loginArmed = false;
      const requestUrl = URL.canParse(params.request.url) ? new URL(params.request.url) : null;
      // Keep optional post-login landing frames blocked, then verify the actor on the known list page.
      const optionalLanding = !this.actor && params.request.method === 'GET' && requestUrl?.origin === this.profile.pdiUrl && requestUrl.pathname === '/ui_page.do' && [...requestUrl.searchParams.keys()].every(key => key === 'sys_id') && SYSID.test(requestUrl.searchParams.get('sys_id') || '');
      if (!permitted && params.resourceType === 'Document' && !optionalLanding) this.scopeFailure = fail(this.actor ? 'BROWSER_SCOPE' : 'BROWSER_INTERACTIVE');
      this.cdp.send(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: params.requestId, ...(!permitted ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => { this.protocolFailure = fail('BROWSER_PROTOCOL'); });
    });
    await this.cdp.send('Page.enable'); await this.cdp.send('Runtime.enable'); await this.cdp.send('Network.enable');
    await this.cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await this.cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await this.cdp.send('Network.setBlockedURLs', { urls: ['ws://*','wss://*'] });
    await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await this.browserCdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{type:'page',exclude:false},{type:'worker',exclude:false},{type:'service_worker',exclude:false},{type:'shared_worker',exclude:false},{exclude:true}] });
    return this;
  }
  async evaluate(expression) {
    this.check(); const value = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); this.check();
    if (value.exceptionDetails) throw fail('BROWSER_PROTOCOL'); return value.result?.value;
  }
  state() {
    return this.evaluate(`(() => { const user = window.NOW && NOW.user; const text = (document.body?.innerText || '').slice(0,12000); return { origin: location.origin, ready: document.readyState, loginForm: Boolean(document.querySelector('#user_name') && document.querySelector('#user_password') && document.querySelector('#sysverb_login')), interactive: Boolean(document.querySelector('input[autocomplete="one-time-code"],input[name="otp"],input[name="mfa_code"]')) || /multi.factor|verification code|authenticator|single sign.on/i.test(text), failed: /invalid (user|password)|login failed|authentication failed|user name or password is invalid/i.test(text), actorId: user?.userID || null, actorName: user?.name || null, impersonating: user?.isImpersonating ?? null, hasToken: typeof window.g_ck === 'string' && window.g_ck.length > 0 }; })()`);
  }
  async navigationState(){
    for(let n=0;n<40;n++){
      try{return await this.state();}catch(e){if(e.code!=='BROWSER_NAVIGATING')throw e;await sleep(100);}
    }
    throw fail('BROWSER_NETWORK');
  }
  async navigate(pathname) {
    this.check(); const navigation = await this.cdp.send('Page.navigate', { url: this.profile.pdiUrl + pathname });
    if (navigation?.errorText) throw fail('BROWSER_NETWORK');
  }
  async signIn(login) {
    this.check(); await this.navigate('/login.do');
    let state, deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) { state = await this.navigationState(); if ((state.origin !== 'null' && state.origin !== this.profile.pdiUrl) || state.interactive) throw fail('BROWSER_INTERACTIVE'); if (state.origin === this.profile.pdiUrl && state.ready === 'complete' && state.loginForm) break; await sleep(150); }
    if (!state?.loginForm) throw fail('BROWSER_INTERACTIVE');
    this.loginArmed = true;
    let submitted;
    try { submitted = await login({ debuggerUrl: this.debuggerUrl, sessionDirectory: this.directory }); } catch (e) { this.loginArmed = false; throw e; }
    if (submitted?.outcome !== 'submitted') { this.loginArmed = false; return submitted; }
    deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) {
      state = await this.navigationState();
      if (state.interactive) throw fail('BROWSER_INTERACTIVE');
      if (state.failed && state.loginForm) throw fail('BROWSER_LOGIN_FAILED');
      if (state.origin === this.profile.pdiUrl && state.ready === 'complete' && !state.loginForm) break;
      await sleep(150);
    }
    if (!state || state.loginForm) throw fail('BROWSER_LOGIN_FAILED');
    await this.navigate('/sys_user_list.do');
    deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) { state = await this.navigationState(); if (state.interactive || state.loginForm) throw fail('BROWSER_INTERACTIVE'); if (state.ready === 'complete' && state.actorId) break; await sleep(150); }
    this.actor = actorState(state, this.profile); this.loginArmed = false;
    return { outcome: 'authenticated', actor: this.actor };
  }
  async read(spec) {
    this.check();
    const url = new URL(spec.url);
    if (url.origin !== this.profile.pdiUrl || url.username || url.password || url.hash || !/^\/api\/now\/table\/(sys_user|sys_dictionary|sys_choice|sys_user_role|sys_user_has_role)$/.test(url.pathname) || !Array.isArray(spec.fields) || spec.fields.some(field => !/^(sys_id|user_name|active|identity_type|web_service_access_only|source|name|element|internal_type|read_only|unique|max_length|value|label|inactive|language|user|role|inherited)$/.test(field)) || !Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 201) throw fail('BROWSER_PROTOCOL');
    const allowedQuery = new Set(['sysparm_display_value','sysparm_exclude_reference_link','sysparm_limit','sysparm_fields','sysparm_query']);
    const queryNames = [...url.searchParams.keys()];
    if (queryNames.some(name => !allowedQuery.has(name)) || new Set(queryNames).size !== queryNames.length || url.searchParams.get('sysparm_fields') !== spec.fields.join(',') || url.searchParams.get('sysparm_limit') !== String(spec.limit) || /javascript:|[\u0000-\u001f]/i.test(url.searchParams.get('sysparm_query') || '')) throw fail('BROWSER_PROTOCOL');
    if (JSON.stringify(actorState(await this.state(), this.profile)) !== JSON.stringify(this.actor)) throw fail('BROWSER_ACTOR');
    this.readUrls.add(url.href);
    try {
      const data = await this.evaluate(`(async () => { if (location.origin !== ${JSON.stringify(this.profile.pdiUrl)} || typeof window.g_ck !== 'string' || !window.g_ck) return {outcome:'interactiveRequired'}; let response; try { response = await fetch(${JSON.stringify(url.href)}, {method:'GET', credentials:'same-origin', redirect:'error', headers:{Accept:'application/json','X-UserToken':window.g_ck}, signal:AbortSignal.timeout(25000)}); } catch { return {outcome:'network'}; } if (response.status===401) return {outcome:'unauthorized'}; if (response.status===403) return {outcome:'forbidden'}; if (response.status!==200 || response.redirected || new URL(response.url).origin!==location.origin) return {outcome:'response'}; const reader=response.body.getReader(), chunks=[]; let size=0; try { for (;;) { const part=await reader.read(); if(part.done) break; size+=part.value.byteLength; if(size>1048576){await reader.cancel();return {outcome:'response'};} chunks.push(part.value); } } catch {return {outcome:'network'};} finally {reader.releaseLock();} const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;} let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return {outcome:'interactiveRequired'};} if(!Array.isArray(body.result)||body.result.length>${spec.limit}) return {outcome:'response'}; const fields=${JSON.stringify(spec.fields)},rows=[];for(const record of body.result){if(!record||typeof record!=='object'||Array.isArray(record))return {outcome:'response'};const row={};for(const field of fields)if(Object.hasOwn(record,field))row[field]=record[field];rows.push(row);} return {outcome:'readable',rows,truncated:rows.length===${spec.limit}}; })()`);
      if (JSON.stringify(actorState(await this.state(), this.profile)) !== JSON.stringify(this.actor)) throw fail('BROWSER_ACTOR');
      if (!data || !['readable','unauthorized','forbidden','response','network','interactiveRequired'].includes(data.outcome) || (data.outcome === 'readable' && (!Array.isArray(data.rows) || typeof data.truncated !== 'boolean'))) throw fail('BROWSER_PROTOCOL');
      return { rows: [], truncated: false, ...data };
    } finally { this.readUrls.delete(url.href); }
  }
  async close() {
    let cleanupFailure = null;
    if (this.browserCdp && !this.exited) { try { await this.browserCdp.send('Browser.close'); } catch { cleanupFailure = fail('BROWSER_CLEANUP'); } }
    this.cdp?.close(); this.browserCdp?.close();
    for (let attempt = 0; this.child && !this.exited && attempt < 40; attempt++) await sleep(100);
    if (this.child && !this.exited) {
      const pid = this.child.pid;
      if (!Number.isInteger(pid)) throw fail('BROWSER_CLEANUP');
      const directory=this.directory.replace(/'/g,"''");
      const stopped = this.spawnImpl('pwsh.exe', ['-NoProfile','-NonInteractive','-Command', `$ErrorActionPreference='Stop';$root=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if(-not $root){exit 0};$marker='--user-data-dir=${directory}';$profileMatch=$root.CommandLine -and ($root.CommandLine.Contains('"'+$marker+'"') -or $root.CommandLine.Contains($marker+' ') -or $root.CommandLine.EndsWith($marker));if(-not $profileMatch -or [IO.Path]::GetFileName($root.ExecutablePath) -ine 'msedge.exe'){throw 'The browser process no longer matches its owned profile.'};$owned=[Collections.Generic.List[object]]::new();$owned.Add($root);for($i=0;$i -lt $owned.Count;$i++){foreach($child in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$owned[$i].ProcessId))){if($child.CreationDate -ge $owned[$i].CreationDate -and $child.ExecutablePath -eq $root.ExecutablePath){$owned.Add($child)}}};for($i=$owned.Count-1;$i -ge 0;$i--){$entry=$owned[$i];try{$process=[Diagnostics.Process]::GetProcessById([int]$entry.ProcessId)}catch [ArgumentException]{continue};try{if([Math]::Abs($process.StartTime.ToUniversalTime().Ticks-$entry.CreationDate.ToUniversalTime().Ticks) -gt [TimeSpan]::TicksPerMillisecond -or $process.MainModule.FileName -ine $entry.ExecutablePath){throw 'Owned browser process identity changed during cleanup.'};$process.Kill();if(-not $process.WaitForExit(5000)){throw 'Owned browser did not exit.'}}finally{$process.Dispose()}};exit 0`], { windowsHide: true, shell: false, stdio: 'ignore' });
      await new Promise((resolve,reject) => { stopped.once('exit', code => code === 0 ? resolve() : reject(fail('BROWSER_CLEANUP'))); stopped.once('error', () => reject(fail('BROWSER_CLEANUP'))); });
      for (let attempt = 0; !this.exited && attempt < 20; attempt++) await sleep(100);
      if (!this.exited) throw fail('BROWSER_CLEANUP');
      cleanupFailure = null;
    }
    if (this.directory) { try { await fs.rm(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); } catch { throw fail('BROWSER_CLEANUP'); } }
    if (cleanupFailure) throw cleanupFailure;
  }
}
module.exports = { IsolatedAdminBrowser, actorState, connectCdp };
