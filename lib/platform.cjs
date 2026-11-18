'use strict';

const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IsolatedAdminBrowser } = require('./browser.cjs');
const { KnowledgePublicationBrowser } = require('./knowledge-browser.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const USER_SELECT = 'id,displayName,userPrincipalName,mail,accountEnabled';
const GRAPH = 'https://graph.microsoft.com';
const MAX_OUTPUT = 1024 * 1024;
const MESSAGES = Object.freeze({
  INVALID_PROFILE: 'The selected profile contains an invalid identity or instance address.',
  INVALID_PURPOSE: 'Choose either the admin or integration credential.',
  WINDOWS_REQUIRED: 'This onboarding step requires Windows and PowerShell 7.',
  POWERSHELL_MISSING: 'PowerShell 7 (pwsh) is required. Install it separately, then retry.',
  CLI_MISSING: 'Azure CLI is required. Install it separately, then retry.',
  CACHE_ACCESS: 'The local CDX sign-in cache could not be secured for this Windows user. No sign-in was started. Check local folder permissions; administrator elevation is not required.',
  CLI_START_FAILED: 'Azure CLI could not start the CDX sign-in request. Check the Azure CLI installation and retry Connect CDX.',
  INTERACTIVE_REQUIRED: 'Credential capture requires an interactive Windows desktop.',
  INPUT_INVALID: 'The onboarding helper rejected its input.',
  CREDENTIAL_SAVE_FAILED: 'The Windows-encrypted credential could not be saved. Check local folder access.',
  CREDENTIAL_IO: 'The saved credential folder could not be accessed.',
  MACHINE_SECRET_EXISTS: 'A different Machine credential is already saved. It was not overwritten. Resolve this local credential before creating a new account.',
  MACHINE_SECRET_MISSING: 'The protected creation credential is missing or belongs to a different operation. Creation/recovery is blocked.',
  HELPER_FAILED: 'The local onboarding helper did not complete successfully.',
  HELPER_PROTOCOL: 'The local onboarding helper returned an invalid result.',
  LOGIN_FAILED: 'Microsoft device sign-in did not complete. Check the tenant and retry.',
  TOKEN_FAILED: 'A Microsoft Graph token could not be acquired for this tenant. Connect Microsoft again.',
  TOKEN_INVALID: 'Microsoft returned a token without a valid tenant identity.',
  TENANT_MISMATCH: 'The signed-in directory does not match the requested tenant. Nothing was verified.',
  DIRECTORY_UNVERIFIED: 'Connect and verify Microsoft for this profile before browsing directory users.',
  DIRECTORY_PERMISSION: 'Microsoft Graph denied directory access. Ask the tenant administrator about directory read permissions.',
  GRAPH_AUTH: 'Microsoft Graph did not accept the sign-in. Connect Microsoft again.',
  GRAPH_UNAVAILABLE: 'Microsoft Graph could not be reached. Check connectivity and retry.',
  GRAPH_THROTTLED: 'Microsoft Graph is temporarily limiting requests. Wait and retry.',
  DIRECTORY_RESPONSE: 'Microsoft Graph returned an unexpected directory response.',
  INVALID_SEARCH: 'Directory search must contain at most 120 characters and no control characters.',
  INVALID_USER: 'Choose a user with a valid directory UUID.',
  USER_NOT_FOUND: 'That directory user could not be found in this tenant.',
  CURSOR_INVALID: 'This directory page is invalid or expired. Start a new search.',
  CANCELLED: 'The onboarding operation was cancelled.',
  TIMED_OUT: 'The onboarding operation timed out. Retry when ready.'
});

function failure(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.HELPER_FAILED);
  error.code = Object.hasOwn(MESSAGES, code) ? code : 'HELPER_FAILED';
  return error;
}
function checkAbort(signal) { if (signal?.aborted) throw failure('CANCELLED'); }
function progress(callback, update) {
  if (typeof callback === 'function') {
    callback(update);
  }
}
function guid(value, code = 'INVALID_PROFILE') {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure(code);
  return value.toLowerCase();
}
function purposeValue(purpose) {
  if (purpose !== 'admin' && purpose !== 'integration') throw failure('INVALID_PURPOSE');
  return purpose;
}
function instanceIdentity(profile, purpose) {
  purposeValue(purpose);
  let url;
  try { url = new URL(profile?.pdiUrl); } catch { throw failure('INVALID_PROFILE'); }
  if (url.protocol !== 'https:' || !/^dev[a-z0-9]+\.service-now\.com$/.test(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' ||
      /[\\\u0000-\u0020]/.test(profile.pdiUrl)) throw failure('INVALID_PROFILE');
  const user = purpose === 'admin' ? profile.adminUser : profile.integrationUser;
  if (typeof user !== 'string' || !user.trim() || user.length > 256 || /[:\u0000-\u001f\u007f]/.test(user)) {
    throw failure('INVALID_PROFILE');
  }
  return { instanceUrl: url.origin, host: url.hostname, user, purpose };
}

// NUL delimiters are unambiguous because identity fields cannot contain NUL.
function credentialKey(profile, purpose) {
  const identity = instanceIdentity(profile, purpose);
  return createHash('sha256').update(`${identity.host}\0${identity.user}\0${identity.purpose}`, 'utf8').digest('hex');
}
function tenantInput(value) {
  if (typeof value !== 'string' || value.length > 100) throw failure('INVALID_PROFILE');
  if (UUID.test(value)) return value.toLowerCase();
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onmicrosoft\.com$/.test(normalized)) throw failure('INVALID_PROFILE');
  return normalized;
}
function tenantAlias(input) { return createHash('sha256').update(input, 'utf8').digest('hex'); }
function normalizedSearch(search) {
  if (typeof search !== 'string' || search.length > 120 || /[\u0000-\u001f\u007f]/.test(search)) throw failure('INVALID_SEARCH');
  return search.trim();
}
function userFilter(search) {
  if (!search) return null;
  const literal = search.replace(/'/g, "''");
  return search.includes('@')
    ? `(userPrincipalName eq '${literal}' or mail eq '${literal}')`
    : `startswith(displayName,'${literal}')`;
}
function tenantClaim(token) {
  try {
    if (typeof token !== 'string' || token.length > 65536) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    // Diagnostic consistency check only; Graph, not this decoder, authenticates the token.
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return guid(claims.tid, 'TOKEN_INVALID');
  } catch { throw failure('TOKEN_INVALID'); }
}
function directoryString(value, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length > 1024) throw failure('DIRECTORY_RESPONSE');
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}
function directoryUser(value) {
  if (!value || typeof value !== 'object' || typeof value.accountEnabled !== 'boolean') throw failure('DIRECTORY_RESPONSE');
  return {
    id: guid(value.id, 'DIRECTORY_RESPONSE'),
    displayName: directoryString(value.displayName ?? ''),
    userPrincipalName: directoryString(value.userPrincipalName),
    mail: directoryString(value.mail, true),
    accountEnabled: value.accountEnabled
  };
}

function runPowerShell(request) {
  return new Promise((resolve, reject) => {
    checkAbort(request.signal);
    if (process.platform !== 'win32') return reject(failure('WINDOWS_REQUIRED'));
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', request.scriptPath, '-Action', request.action];
    const child = spawn('pwsh.exe', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderrBytes = 0, settled = false;
    const stopTree = () => {
      if (child.pid) {
        const ownedPid = Number(child.pid);
        const script = `$owned = @(${ownedPid}); $queue = @(${ownedPid}); while ($queue.Count -gt 0) { $parent = $queue[0]; $queue = @($queue | Select-Object -Skip 1); $children = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $parent) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId); $owned += $children; $queue += $children }; foreach ($id in @($owned | Sort-Object -Descending -Unique)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`;
        const killer = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const finish = (error, result, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      if (terminate) stopTree();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(failure('CANCELLED'), null, true);
    const timer = setTimeout(() => finish(failure('TIMED_OUT'), null, true), request.timeoutMs);
    request.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT) finish(failure('HELPER_PROTOCOL'), null, true);
    });
    child.stderr.on('data', chunk => {
      if (settled) return;
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
      if (stderrBytes > MAX_OUTPUT) return finish(failure('HELPER_PROTOCOL'), null, true);
      try { request.onStderr?.(chunk); }
      catch { finish(failure('HELPER_PROTOCOL'), null, true); }
    });
    child.stdin.on('error', () => finish(failure('HELPER_FAILED'), null, true));
    child.on('error', error => finish(failure(error.code === 'ENOENT' ? 'POWERSHELL_MISSING' : 'HELPER_FAILED')));
    child.on('close', exitCode => finish(null, { stdout, exitCode }));
    child.stdin.end(JSON.stringify(request.input));
    if (request.signal?.aborted) abort();
  });
}

class PlatformAdapter {
  constructor({ runtimeHome, scriptRoot = path.join(__dirname, '..', 'scripts'), fetchImpl = global.fetch, processRunner = runPowerShell, browserFactory = options => new IsolatedAdminBrowser(options), knowledgeBrowserFactory = options => new KnowledgePublicationBrowser(options) } = {}) {
    if (typeof runtimeHome !== 'string' || !path.isAbsolute(runtimeHome) || typeof scriptRoot !== 'string' ||
        !path.isAbsolute(scriptRoot) || typeof fetchImpl !== 'function' || typeof processRunner !== 'function') throw failure('INVALID_PROFILE');
    this.runtimeHome = path.resolve(runtimeHome);
    this.scriptRoot = path.resolve(scriptRoot);
    this.fetchImpl = fetchImpl;
    this.processRunner = processRunner;
    if (typeof browserFactory !== 'function') throw failure('INVALID_PROFILE');
    this.browserFactory = browserFactory;
    if(typeof knowledgeBrowserFactory!=='function')throw failure('INVALID_PROFILE');
    this.knowledgeBrowserFactory=knowledgeBrowserFactory;
    this.isolatedAdminBrowser = true;
    this.cursorSecret = randomBytes(32);
  }

  _credentialInput(profile, purpose) {
    guid(profile?.id);
    const { instanceUrl, user } = instanceIdentity(profile, purpose);
    return { instanceUrl, user, purpose, filePath: path.join(this.runtimeHome, 'credentials', `${credentialKey(profile, purpose)}.clixml`) };
  }

  async _helper(script, action, input, { signal, onStderr, timeoutMs = 60000 } = {}) {
    checkAbort(signal);
    const sensitive = script === 'credential.ps1' && ['Save','SetPersonPassword','VerifyPersonPassword'].includes(action);
    const request = { scriptPath: path.join(this.scriptRoot, script), action, input, signal, onStderr, timeoutMs };
    let result;
    try {
      result = await this.processRunner(request);
    } catch (error) {
      if (signal?.aborted) throw failure('CANCELLED');
      throw failure(Object.hasOwn(MESSAGES, error?.code) ? error.code : 'HELPER_FAILED');
    } finally {
      if (sensitive) {
        delete input.password;
        request.input = null;
        input = null;
      }
    }
    checkAbort(signal);
    let data;
    try {
      if (typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT) throw new Error();
      data = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') throw new Error();
    } catch { throw failure('HELPER_PROTOCOL'); }
    if (!data.ok) throw failure(data.code);
    if (result.exitCode != null && result.exitCode !== 0) throw failure('HELPER_FAILED');
    return data;
  }

  async credentialStatus(profile) {
    const inputs = ['admin', 'integration'].map(purpose => this._credentialInput(profile, purpose));
    const exists = async filePath => {
      try { await fs.access(filePath); return true; }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw failure('CREDENTIAL_IO'); }
    };
    const [admin, integration] = await Promise.all(inputs.map(input => exists(input.filePath)));
    return { admin, integration };
  }

  async captureCredential(profile, purpose, onProgress, { signal } = {}) {
    const input = this._credentialInput(profile, purpose);
    progress(onProgress, { status: 'waiting', message: 'Complete the separate masked Windows credential dialog. Remember is optional.' });
    try {
      const data = await this._helper('credential.ps1', 'Capture', input, { signal, timeoutMs: 330000 });
      if (typeof data.saved !== 'boolean' || (data.cancelled != null && typeof data.cancelled !== 'boolean') || (data.cancelled && data.saved)) throw failure('HELPER_PROTOCOL');
      return data.cancelled ? { saved: false, cancelled: true } : { saved: data.saved };
    } catch (error) {
      if (error.code === 'CANCELLED') return { saved: false, cancelled: true };
      throw error;
    }
  }

  async saveCredential(profile, purpose, password, { signal } = {}) {
    let input;
    try {
      if (typeof password !== 'string' || password.length < 1 || password.length > 4096 || password.includes('\0')) throw failure('INPUT_INVALID');
      input = { ...this._credentialInput(profile, purpose), password };
      password = null;
      const data = await this._helper('credential.ps1', 'Save', input, { signal });
      if (Object.keys(data).length !== 2 || data.ok !== true || data.saved !== true) throw failure('HELPER_PROTOCOL');
      return { saved: true };
    } catch (error) {
      throw failure(Object.hasOwn(MESSAGES, error?.code) ? error.code : 'HELPER_FAILED');
    } finally {
      password = null;
      if (input) delete input.password;
      input = null;
    }
  }

  async testPdi(profile, purpose, { signal } = {}) {
    const data = await this._helper('credential.ps1', 'Test', this._credentialInput(profile, purpose), { signal, timeoutMs: 35000 });
    const outcomes = {
      missing: ['unknown', 'No credential is saved for this identity. Capture it with Remember enabled before testing.'],
      unreadable: ['unknown', 'The saved Windows credential could not be opened by this Windows user. Capture it again.'],
      identityMismatch: ['blocked', 'The saved credential identity does not match this profile. Capture it again.'],
      unauthorized: ['blocked', 'The instance rejected the credential (HTTP 401).'],
      forbidden: ['blocked', 'The instance denied incident read access (HTTP 403). No permissions were changed.'],
      empty: ['authenticated', 'The instance accepted the request, but returned no visible incidents. Incident read capability remains uncertain.'],
      readable: ['authenticated', 'The instance accepted the request and returned one visible incident identifier.'],
      redirect: ['unknown', 'The instance attempted a redirect. Redirects are not allowed for credential tests.'],
      network: ['unknown', 'The instance could not be reached within the test timeout. Check connectivity and instance availability.'],
      response: ['unknown', 'The instance returned an unexpected response. Authentication could not be confirmed.']
    };
    const outcome = outcomes[data.outcome];
    if (!outcome || data.status !== outcome[0]) throw failure('HELPER_PROTOCOL');
    const result = { status: outcome[0], checkedAt: new Date().toISOString(), message: outcome[1], writeAccessTested: false };
    if (data.outcome === 'empty' || data.outcome === 'readable') result.visibleSampleCount = data.outcome === 'empty' ? 0 : 1;
    return result;
  }

  _onboardingRows(data) {
    const allowed = ['missing','unreadable','identityMismatch','unauthorized','forbidden','interactiveRequired','response','network','readable'];
    if (!allowed.includes(data?.outcome)) throw failure('HELPER_PROTOCOL');
    if (data.outcome !== 'readable') return { outcome: data.outcome, rows: [], truncated: false };
    if (!Array.isArray(data.rows) || data.rows.length > 201 || typeof data.truncated !== 'boolean') throw failure('HELPER_PROTOCOL');
    const fields = new Set(['sys_id','user_name','email','first_name','last_name','active','identity_type','web_service_access_only','source','title','reference','name','element','internal_type','read_only','unique','max_length','value','label','inactive','language','user','role','inherited','number','short_description','description','caller_id','assigned_to','assignment_group','category','impact','urgency','state','correlation_id','sys_created_by','sys_mod_count','text','author','kb_knowledge_base','kb_category','workflow_state','latest','article_id','version','valid_to','sys_updated_by','owner','parent_id','parent_table','user_criteria','users','groups','roles','companies','locations','departments','advanced','script','match_all']);
    const rows = data.rows.map(record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw failure('HELPER_PROTOCOL');
      const row = {};
      for (const [field, raw] of Object.entries(record)) {
        if (!fields.has(field)) continue;
        if (['user','role','internal_type','caller_id','assigned_to','assignment_group','author','kb_knowledge_base','kb_category','owner','parent_id','user_criteria'].includes(field) && raw && typeof raw === 'object') {
          if (Array.isArray(raw) || typeof raw.value !== 'string' || Object.keys(raw).some(key => !['value','display_value','link'].includes(key))) throw failure('HELPER_PROTOCOL');
          row[field] = raw.value;
        } else row[field] = raw;
      }
      return row;
    });
    return { outcome: 'readable', rows, truncated: data.truncated };
  }
  async _pdiRows(profile, purpose, resource, options = {}, signal) {
    return this._onboardingRows(await this._helper('credential.ps1', 'ReadOnboarding', { ...this._credentialInput(profile, purpose), resource, ...options }, { signal, timeoutMs: 35000 }));
  }

  async discoverOnboarding(profile, roleNames, { signal } = {}) {
    if (profile.bootstrapMode === 'machine') {
      const read = async (resource, options) => this._onboardingRows(await this._helper('credential.ps1','ReadBootstrap',{...this._credentialInput(profile,'integration'),resource,...options},{signal,timeoutMs:35000}));
      const actor = await read('actor');
      if (actor.outcome !== 'readable') return {access:actor.outcome,credentialPurpose:'integration'};
      return {...await this._collectOnboarding(profile,roleNames,read,actor),credentialPurpose:'integration'};
    }
    const read = (resource, options) => this._pdiRows(profile, 'admin', resource, options, signal);
    const actor = await read('actor');
    if (['unauthorized','interactiveRequired'].includes(actor.outcome)) return this._browserDiscovery(profile, roleNames, signal);
    if (actor.outcome !== 'readable') return { access: actor.outcome };
    return this._collectOnboarding(profile, roleNames, read, actor);
  }

  async readBootstrap(profile, resource, options = {}, {signal} = {}) {
    if (profile.bootstrapMode !== 'machine') throw failure('INPUT_INVALID');
    return this._onboardingRows(await this._helper('credential.ps1','ReadBootstrap',{...this._credentialInput(profile,'integration'),resource,...options},{signal,timeoutMs:35000}));
  }

  async _knowledgeBrowser(profile,article,{signal}={},work) {
    const session=this.knowledgeBrowserFactory({runtimeHome:this.runtimeHome,profile,article,signal});
    try{
      await session.start();
      const login=await session.signIn(owned=>this._helper('credential.ps1','BrowserLogin',{...this._credentialInput(profile,'admin'),...owned},{signal,timeoutMs:35000}));
      if(login?.outcome!=='authenticated')throw Object.assign(new Error('The saved separate admin credential did not establish the normal publication UI actor.'),{code:'PUBLICATION_LOGIN',status:409});
      const view=await session.openArticle();return await work(session,view);
    }finally{await session.close();}
  }
  async discoverPublication(profile,article,options={}) {return this._knowledgeBrowser(profile,article,options,async(session,view)=>view);}
  async publishKnowledge(profile,article,expected,{signal,beforeSubmit}={}) {
    return this._knowledgeBrowser(profile,article,{signal},async(session,view)=>{
      const {digest}=require('./execution.cjs');
      if(digest(view)!==digest(expected)||typeof beforeSubmit!=='function')throw Object.assign(new Error('Publication actor/action changed or the durable attempt callback is missing.'),{code:'PUBLICATION_CHANGED',status:409});
      await beforeSubmit(view);return session.publish(expected);
    });
  }

  async personOperation(profile, action, actor, operation, machineChoice, {signal,role,grantId} = {}) {
    if (profile.bootstrapMode !== 'machine' || actor?.authMethod !== 'basic-machine-principal' || !['CreatePerson','CreatePersonRole'].includes(action)) throw failure('INPUT_INVALID');
    const fields=operation.fields;
    const input={...this._credentialInput(profile,'integration'),operationId:operation.operationId,recordId:fields.sys_id,targetUser:fields.user_name,email:fields.email,firstName:fields.first_name,lastName:fields.last_name,humanChoice:fields.identity_type,machineChoice,expectedActorId:actor.sysId};
    if(role){input.roleName=role.name;input.roleId=role.sysId;input.grantId=grantId;}
    const result=await this._helper('credential.ps1',action,input,{signal,timeoutMs:210000});
    if(!['created','rejected','uncertain'].includes(result.outcome))throw failure('HELPER_PROTOCOL');
    return {outcome:result.outcome,...(result.row?{row:this._onboardingRows({outcome:'readable',rows:[result.row],truncated:false}).rows[0]}:{})};
  }

  async contentOperation(profile,actor,operation,machineChoice,references,{signal}={}) {
    if(profile.bootstrapMode!=='machine'||actor?.authMethod!=='basic-machine-principal'||!['incident','kb_knowledge'].includes(operation?.table))throw failure('INPUT_INVALID');
    const input={...this._credentialInput(profile,'integration'),expectedActorId:actor.sysId,machineChoice,table:operation.table,operationId:operation.operationId,payload:operation.fields,person:references[operation.table==='incident'?'caller':'author'],humanChoice:references.humanChoice};
    if(operation.table==='kb_knowledge')input.workflowLabel=operation.workflowLabel;
    const result=await this._helper('credential.ps1','CreateContent',input,{signal,timeoutMs:210000});
    if(!['created','rejected','uncertain'].includes(result.outcome))throw failure('HELPER_PROTOCOL');
    return {outcome:result.outcome,...(result.row?{row:this._onboardingRows({outcome:'readable',rows:[result.row],truncated:false}).rows[0]}:{})};
  }

  async knowledgePackOperation(profile,actor,operation,machineChoice,person,{signal}={}) {
    if(profile.bootstrapMode!=='machine'||actor?.authMethod!=='basic-machine-principal'||!['kb_knowledge_base','kb_category','user_criteria','kb_uc_can_read_mtom','kb_uc_can_contribute_mtom','kb_knowledge'].includes(operation?.table)||!['POST','PATCH'].includes(operation.method))throw failure('INPUT_INVALID');
    const {humanChoice,ids,...reference}=person;
    const input={...this._credentialInput(profile,'integration'),expectedActorId:actor.sysId,machineChoice,humanChoice,person:reference,packIds:ids,method:operation.method,table:operation.table,operationId:operation.operationId,payload:operation.fields};
    if(operation.table==='kb_knowledge')input.workflowLabel='Published';
    const result=await this._helper('credential.ps1','CreateKnowledgePack',input,{signal,timeoutMs:210000});
    if(!['created','rejected','uncertain'].includes(result.outcome))throw failure('HELPER_PROTOCOL');
    return {outcome:result.outcome,...(result.row?{row:this._onboardingRows({outcome:'readable',rows:[result.row],truncated:false}).rows[0]}:{})};
  }

  async personPassword(profile,actor,target,machineChoice,password,{signal,verifyOnly=false}={}) {
    let input;
    try{
      if(profile.bootstrapMode!=='machine'||actor?.authMethod!=='basic-machine-principal'||typeof password!=='string'||!password.length||password.length>4096||password.includes('\0'))throw failure('INPUT_INVALID');
      input={...this._credentialInput(profile,'integration'),expectedActorId:actor.sysId,recordId:target.sysId,targetUser:target.userName,email:target.email,humanChoice:target.identityType,machineChoice,password};password=null;
      const result=await this._helper('credential.ps1',verifyOnly?'VerifyPersonPassword':'SetPersonPassword',input,{signal,timeoutMs:210000});
      if(!['verified','applied','rejected','uncertain'].includes(result.outcome)||typeof result.updateAccepted!=='boolean'||!['authenticated','not-verified'].includes(result.authentication)||(result.outcome==='applied'&&!result.updateAccepted)||(result.outcome==='verified'&&result.authentication!=='authenticated'))throw failure('HELPER_PROTOCOL');
      return {outcome:result.outcome,updateAccepted:result.updateAccepted,authentication:result.authentication};
    }finally{password=null;if(input)delete input.password;}
  }

  async _browserDiscovery(profile, roleNames, signal) {
    const session = this.browserFactory({ runtimeHome: this.runtimeHome, profile, signal });
    try {
      await session.start();
      const login = await session.signIn(owned => this._helper('credential.ps1', 'BrowserLogin', { ...this._credentialInput(profile, 'admin'), ...owned }, { signal, timeoutMs: 35000 }));
      if (!['authenticated','missing','unreadable','identityMismatch','interactiveRequired'].includes(login?.outcome)) throw failure('HELPER_PROTOCOL');
      if (login.outcome !== 'authenticated') return { access: login.outcome };
      const read = async (resource, options) => {
        const spec = await this._helper('credential.ps1', 'DescribeOnboarding', { ...this._credentialInput(profile, 'admin'), resource, ...options }, { signal });
        return this._onboardingRows(await session.read(spec));
      };
      const actor = await read('actor');
      if (actor.outcome !== 'readable') return { access: actor.outcome };
      return { ...await this._collectOnboarding(profile, roleNames, read, actor), access: 'browser', browserActor: session.actor };
    } catch (e) {
      if (e.code === 'BROWSER_INTERACTIVE') return { access: 'interactiveRequired' };
      if (e.code === 'BROWSER_LOGIN_FAILED') return { access: 'loginFailed' };
      if (e.code === 'BROWSER_ACTOR') return { access: 'identityMismatch' };
      throw e;
    } finally { await session.close(); }
  }

  async _collectOnboarding(profile, roleNames, read, actor) {
    const machine = await read('machine', { targetUser: profile.integrationUser });
    const dictionary = await read('dictionary');
    const choices = await read('choices');
    const roles = await read('roles', { roleNames: [...new Set(['admin', ...roleNames])] });
    const validId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
    const actorGrants = actor.rows.length === 1 && validId(actor.rows[0].sys_id) ? await read('grants', { recordId: actor.rows[0].sys_id }) : null;
    const machineGrants = machine.rows.length === 1 && validId(machine.rows[0].sys_id) ? actor.rows.length === 1 && machine.rows[0].sys_id === actor.rows[0].sys_id ? actorGrants : await read('grants', { recordId: machine.rows[0].sys_id }) : null;
    let existingRoles = null;
    if (machineGrants?.outcome === 'readable' && !machineGrants.truncated && machineGrants.rows.every(row => validId(row.role))) {
      const roleIds = [...new Set(machineGrants.rows.map(row => row.role))];
      existingRoles = roleIds.length ? await read('roleIds', { roleIds }) : { outcome: 'readable', rows: [], truncated: false };
    }
    return { access: 'api', actor, actorGrants, machine, machineGrants, dictionary, choices, roles, existingRoles };
  }

  async verifyMachine(profile, expectedSysId, { signal, identityType } = {}) {
    const actor = await this._pdiRows(profile, 'integration', 'actor', {}, signal);
    if (actor.outcome !== 'readable' || actor.rows.length !== 1 || actor.rows[0].sys_id !== expectedSysId || actor.rows[0].user_name !== profile.integrationUser || ![true, 'true'].includes(actor.rows[0].active) || ![true, 'true'].includes(actor.rows[0].web_service_access_only) || typeof identityType !== 'string' || actor.rows[0].identity_type !== identityType) return { status: 'blocked', outcome: actor.outcome === 'readable' ? 'identityMismatch' : actor.outcome, incident: 'not-checked', knowledge: 'not-checked', writeAccessTested: false };
    const incident = await this._pdiRows(profile, 'integration', 'incident', {}, signal);
    const knowledge = await this._pdiRows(profile, 'integration', 'knowledge', {}, signal);
    const classify = data => data.outcome === 'readable' ? data.rows.length === 0 ? 'empty-uncertain' : data.rows.length === 1 && /^[0-9a-f]{32}$/.test(data.rows[0]?.sys_id || '') ? 'readable' : 'response' : data.outcome;
    const reads = { incident: classify(incident), knowledge: classify(knowledge) };
    return { status: Object.values(reads).every(value => ['readable', 'empty-uncertain'].includes(value)) ? 'authenticated' : 'blocked', ...reads, sysId: expectedSysId, userName: profile.integrationUser, writeAccessTested: false };
  }

  async machineOperation(profile, action, plan, { signal, role, grantId } = {}) {
    if (!['PrepareMachineSecret','CreateMachine','CreateMachineRole','PromoteMachineSecret'].includes(action) || !UUID.test(plan?.id || '') || plan.payload?.mode !== 'create' || plan.payload.actor?.authMethod !== 'basic-exact-principal') throw failure('INPUT_INVALID');
    const fields = plan.payload.proposedFields;
    const input = { ...this._credentialInput(profile, 'admin'), operationId: plan.id, targetUser: profile.integrationUser, recordId: fields.sys_id, machineChoice: fields.identity_type, expectedActorId: plan.payload.actor.sysId };
    if (action === 'CreateMachineRole') { input.roleId = role?.sysId; input.grantId = grantId; }
    const result = await this._helper('credential.ps1', action, input, { signal, timeoutMs: 210000 });
    if (!['prepared','promoted','created','uncertain','rejected'].includes(result.outcome)) throw failure('HELPER_PROTOCOL');
    return {outcome:result.outcome,...(result.row ? {row:this._onboardingRows({outcome:'readable',rows:[result.row],truncated:false}).rows[0]} : {})};
  }

  _tenant(profile, requireVerified = false) {
    const profileId = guid(profile?.id);
    const input = tenantInput(profile.tenantInput);
    const alias = tenantAlias(input);
    if (profile.authCacheKey != null && (typeof profile.authCacheKey !== 'string' || !HASH.test(profile.authCacheKey) || profile.authCacheKey !== alias)) throw failure('INVALID_PROFILE');
    const verifiedId = profile.tenantId == null ? null : guid(profile.tenantId);
    if (requireVerified && (profile.microsoftVerified !== true || !verifiedId || profile.authCacheKey !== alias)) throw failure('DIRECTORY_UNVERIFIED');
    if (verifiedId && UUID.test(input) && verifiedId !== input) throw failure('TENANT_MISMATCH');
    return { profileId, input, alias, verifiedId, configDir: path.join(this.runtimeHome, 'tenants', alias, 'azure-cli') };
  }

  async _token(tenant, requestedTenant, signal) {
    const data = await this._helper('azure-cli.ps1', 'Token', { tenant: requestedTenant, configDir: tenant.configDir }, { signal });
    const tid = tenantClaim(data.accessToken);
    if (UUID.test(requestedTenant) && tid !== requestedTenant.toLowerCase()) throw failure('TENANT_MISMATCH');
    return { token: data.accessToken, tid };
  }

  async _graph(url, token, signal) {
    checkAbort(signal);
    const target = new URL(url);
    if (target.origin !== GRAPH || !['/v1.0/organization', '/v1.0/users'].includes(target.pathname) && !/^\/v1\.0\/users\/[0-9a-f-]{36}$/.test(target.pathname)) throw failure('DIRECTORY_RESPONSE');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 25000);
    try {
      checkAbort(signal);
      const response = await this.fetchImpl(target.href, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (response.status === 401) throw failure('GRAPH_AUTH');
      if (response.status === 403) throw failure('DIRECTORY_PERMISSION');
      if (response.status === 404) throw failure('USER_NOT_FOUND');
      if (response.status === 429) throw failure('GRAPH_THROTTLED');
      if (response.status !== 200 || response.redirected || response.url && new URL(response.url).origin !== GRAPH) throw failure('DIRECTORY_RESPONSE');
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_OUTPUT) { await reader.cancel(); throw failure('DIRECTORY_RESPONSE'); }
            chunks.push(Buffer.from(value));
          }
          text = Buffer.concat(chunks).toString('utf8');
        } finally { reader.releaseLock(); }
      } else {
        text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT) throw failure('DIRECTORY_RESPONSE');
      }
      try { return JSON.parse(text); } catch { throw failure('DIRECTORY_RESPONSE'); }
    } catch (error) {
      if (signal?.aborted) throw failure('CANCELLED');
      if (Object.hasOwn(MESSAGES, error?.code)) throw failure(error.code);
      throw failure('GRAPH_UNAVAILABLE');
    } finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async connectMicrosoft(profile, onProgress, { signal } = {}) {
    const tenant = this._tenant(profile);
    let stderr = '', lastCode = '';
    const onStderr = chunk => {
      stderr = (stderr + String(chunk)).slice(-8192);
      const match = stderr.match(/https:\/\/microsoft\.com\/devicelogin\b[\s\S]{0,240}?\bcode\s+([A-Z0-9]{6,20})\b/i);
      if (match && match[1] !== lastCode) {
        lastCode = match[1];
        progress(onProgress, { status: 'waiting', message: 'Open the official Microsoft device sign-in page and enter this code for the requested tenant.', deviceCode: match[1], verificationUrl: 'https://microsoft.com/devicelogin' });
      }
    };
    progress(onProgress, { status: 'running', message: 'Starting Microsoft device sign-in in an isolated local tenant cache.' });
    await this._helper('azure-cli.ps1', 'Login', { tenant: tenant.input, configDir: tenant.configDir }, { signal, onStderr, timeoutMs: 900000 });
    progress(onProgress, { status: 'running', message: 'Verifying the signed-in directory with Microsoft Graph.' });
    const { token, tid } = await this._token(tenant, tenant.input, signal);
    const url = new URL(`${GRAPH}/v1.0/organization`);
    url.searchParams.set('$select', 'id,displayName');
    const data = await this._graph(url, token, signal);
    if (!data || !Array.isArray(data.value) || data.value.length !== 1) throw failure('DIRECTORY_RESPONSE');
    const organization = data.value[0];
    const tenantId = guid(organization?.id, 'DIRECTORY_RESPONSE');
    if (tenantId !== tid || UUID.test(tenant.input) && tenantId !== tenant.input || tenant.verifiedId && tenantId !== tenant.verifiedId) throw failure('TENANT_MISMATCH');
    return { tenantId, tenantDisplayName: directoryString(organization.displayName), authCacheKey: tenant.alias };
  }

  _nextLink(link, search) {
    if (typeof link !== 'string' || link.length > 8192 || !link.startsWith(`${GRAPH}/`) || /[\\\u0000-\u0020]/.test(link)) throw failure('CURSOR_INVALID');
    let url;
    try { url = new URL(link); } catch { throw failure('CURSOR_INVALID'); }
    if (url.origin !== GRAPH || url.port || url.username || url.password || url.hash || url.pathname !== '/v1.0/users') throw failure('CURSOR_INVALID');
    const allowed = new Set(['$top', '$select', '$filter', '$skiptoken', '$skip']);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw failure('CURSOR_INVALID');
    }
    const top = url.searchParams.get('$top');
    if (!top || !/^\d{1,2}$/.test(top) || Number(top) < 1 || Number(top) > 25 ||
        url.searchParams.get('$select') !== USER_SELECT || url.searchParams.get('$filter') !== userFilter(search)) throw failure('CURSOR_INVALID');
    const skip = url.searchParams.get('$skip');
    const skipToken = url.searchParams.get('$skiptoken');
    if ((!skipToken && skip == null) || skipToken && skipToken.length > 4096 || skip != null && !/^\d{1,10}$/.test(skip)) throw failure('CURSOR_INVALID');
    return url.href;
  }

  _cursor(link, tenant, search) {
    const body = Buffer.from(JSON.stringify({ v: 1, url: this._nextLink(link, search), profile: tenant.profileId, tenant: tenant.verifiedId, search }), 'utf8').toString('base64url');
    return `${body}.${createHmac('sha256', this.cursorSecret).update(body).digest('base64url')}`;
  }

  _cursorUrl(cursor, tenant, search) {
    if (typeof cursor !== 'string' || cursor.length > 16000) throw failure('CURSOR_INVALID');
    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw failure('CURSOR_INVALID');
    const expected = createHmac('sha256', this.cursorSecret).update(parts[0]).digest();
    const signature = Buffer.from(parts[1], 'base64url');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw failure('CURSOR_INVALID');
    let data;
    try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw failure('CURSOR_INVALID'); }
    if (data?.v !== 1 || data.profile !== tenant.profileId || data.tenant !== tenant.verifiedId || data.search !== search) throw failure('CURSOR_INVALID');
    return this._nextLink(data.url, search);
  }

  async listUsers(profile, { search = '', cursor = null } = {}, { signal } = {}) {
    const tenant = this._tenant(profile, true);
    const term = normalizedSearch(search);
    let url;
    if (cursor != null) url = this._cursorUrl(cursor, tenant, term);
    else {
      url = new URL(`${GRAPH}/v1.0/users`);
      url.searchParams.set('$top', '25');
      url.searchParams.set('$select', USER_SELECT);
      if (term) url.searchParams.set('$filter', userFilter(term));
    }
    const { token } = await this._token(tenant, tenant.verifiedId, signal);
    const data = await this._graph(url, token, signal);
    if (!data || !Array.isArray(data.value) || data.value.length > 25) throw failure('DIRECTORY_RESPONSE');
    const users = data.value.map(directoryUser);
    const nextCursor = data['@odata.nextLink'] == null ? null : this._cursor(data['@odata.nextLink'], tenant, term);
    return { users, nextCursor };
  }

  async resolveUser(profile, userId, { signal } = {}) {
    const tenant = this._tenant(profile, true);
    const id = guid(userId, 'INVALID_USER');
    const { token } = await this._token(tenant, tenant.verifiedId, signal);
    const url = new URL(`${GRAPH}/v1.0/users/${id}`);
    url.searchParams.set('$select', USER_SELECT);
    const user = directoryUser(await this._graph(url, token, signal));
    if (user.id !== id) throw failure('DIRECTORY_RESPONSE');
    return user;
  }
}

module.exports = { PlatformAdapter, credentialKey };
