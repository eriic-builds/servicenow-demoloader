'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { IsolatedAdminBrowser, actorState, connectCdp } = require('../lib/browser.cjs');
const { PlatformAdapter } = require('../lib/platform.cjs');
const { snapshot } = require('../lib/onboarding.cjs');
const PROFILE = {id:'11111111-1111-1111-1111-111111111111',pdiUrl:'https://dev123.service-now.com',adminUser:'admin',integrationUser:'machine_test',integrationMode:'existing'};
const ADMIN='a'.repeat(32), MACHINE='b'.repeat(32), ROLE='c'.repeat(32), ITIL='d'.repeat(32);
const read=rows=>({outcome:'readable',rows,truncated:false});
const goodState=()=>({origin:PROFILE.pdiUrl,ready:'complete',loginForm:false,interactive:false,failed:false,actorId:ADMIN,actorName:'admin',impersonating:false,hasToken:true});
async function root(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'.sn-browser-'));t.after(()=>fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:250}));return directory;}
function source(){return {access:'browser',browserActor:{sysId:ADMIN,userName:'admin',authMethod:'isolated-browser-session',impersonating:false},actor:read([{sys_id:ADMIN,user_name:'admin',active:'true',web_service_access_only:'false'}]),actorGrants:read([{sys_id:'1'.repeat(32),user:ADMIN,role:ROLE}]),machine:read([{sys_id:MACHINE,user_name:'machine_test',active:'true',identity_type:'installed-machine',web_service_access_only:'true'}]),machineGrants:read([{sys_id:'2'.repeat(32),user:MACHINE,role:ITIL}]),existingRoles:read([{sys_id:ITIL,name:'itil'}]),roles:read([{sys_id:ROLE,name:'admin'},{sys_id:ITIL,name:'itil'}]),dictionary:read(['user_name','active','identity_type','web_service_access_only'].map((element,index)=>({sys_id:String(index+3).repeat(32),name:'sys_user',element,internal_type:'string',read_only:'false'}))),choices:read([{sys_id:'7'.repeat(32),name:'sys_user',element:'identity_type',value:'installed-machine',label:'Machine',language:'en',inactive:'false'}])};}
async function fakeSession(t, final=goodState()){
  const directory=await root(t),handlers=new Map(),requests=[];
  let stage='login',child;
  const page={on:(method,callback)=>handlers.set(method,callback),close(){},async send(method,params){
    if(method==='Page.navigate'){stage=params.url.endsWith('/login.do')?'login':'signed';return {};}
    if(method==='Runtime.evaluate')return {result:{value:params.expression.startsWith('(async')?read([{sys_id:ADMIN,user_name:'admin'}]):stage==='login'?{...goodState(),loginForm:true}:final}};
    if(method.startsWith('Fetch.'))requests.push({method,requestId:params.requestId});return {};
  }};
  const browser={on(){},close(){},async send(method){if(method==='Browser.close')child.emit('exit',0);return {};}};
  const session=new IsolatedAdminBrowser({runtimeHome:directory,profile:PROFILE,loginTimeoutMs:200,spawnImpl:(exe,args)=>{
    child=new EventEmitter();child.pid=91234;
    const profileDir=args.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    fs.writeFile(path.join(profileDir,'DevToolsActivePort'),'9227\n/devtools/browser/owned-browser\n');return child;
  },fetchImpl:async()=>new Response(JSON.stringify([{type:'page',url:'about:blank',id:'owned-page',webSocketDebuggerUrl:'ws://127.0.0.1:9227/devtools/page/owned-page'}])),connectImpl:async url=>url.includes('/browser/')?browser:page});
  await session.start();
  t.after(()=>session.close());
  return {session,handlers,requests,login:async()=>{stage='signed';return {outcome:'submitted'};}};
}

test('isolated browser submits normal login once and verifies exact actor before GETs',async t=>{
  const f=await fakeSession(t);assert.equal((await f.session.signIn(async()=>{
    assert.equal(f.session.permits({url:PROFILE.pdiUrl+'/login.do',method:'POST'}),true);
    await f.handlers.get('Fetch.requestPaused')({request:{url:PROFILE.pdiUrl+'/login.do',method:'POST',postData:'mock-secret-must-not-log'},requestId:'normal-login',resourceType:'Document'});
    return f.login();
  })).outcome,'authenticated');assert.equal(f.session.actor.authMethod,'isolated-browser-session');
  assert.equal(f.session.permits({url:PROFILE.pdiUrl+'/login.do',method:'POST'}),false);assert.ok(!JSON.stringify(f.requests).includes('mock-secret'));
  const spec={url:PROFILE.pdiUrl+'/api/now/table/sys_user?sysparm_fields=sys_id,user_name&sysparm_limit=2',fields:['sys_id','user_name'],limit:2};
  assert.equal((await f.session.read(spec)).rows[0].sys_id,ADMIN);
});

test('owned Edge cleanup handles a missing graceful-close response without stopping other browsers',{skip:process.platform!=='win32'},async t=>{
  const directory=await root(t);let forced=false;
  const session=new IsolatedAdminBrowser({runtimeHome:directory,profile:PROFILE,connectImpl:async url=>{
    const transport=await connectCdp(url);
    if(!url.includes('/browser/'))return transport;
    return {on:(...args)=>transport.on(...args),close:()=>transport.close(),send:async(method,...args)=>{if(method==='Browser.close'){forced=true;return {};}return transport.send(method,...args);}};
  }});
  t.after(()=>session.close());await session.start();const owned=session.directory;
  await session.close();assert.equal(forced,true);assert.equal(session.exited,true);await assert.rejects(fs.access(owned),{code:'ENOENT'});
});

test('invalid, wrong-name, impersonated or tokenless browser actors are never accepted',async t=>{
  for(const change of [s=>{s.actorId='invalid';},s=>{s.actorName='other';},s=>{s.impersonating=true;},s=>{s.impersonating=null;},s=>{s.hasToken=false;}]){
    const state=goodState();change(state);const f=await fakeSession(t,state);await assert.rejects(f.session.signIn(f.login),{code:'BROWSER_ACTOR'});
  }
});

test('failed normal login and MFA states are blocked rather than success fallbacks',async t=>{
  const failed=await fakeSession(t,{...goodState(),loginForm:true,failed:true});await assert.rejects(failed.session.signIn(failed.login),{code:'BROWSER_LOGIN_FAILED'});
  const mfa=await fakeSession(t,{...goodState(),interactive:true});await assert.rejects(mfa.session.signIn(mfa.login),{code:'BROWSER_INTERACTIVE'});
});

test('redirect/SSO, arbitrary POSTs, cross-host reads and secret-field requests are blocked',async t=>{
  const f=await fakeSession(t);
  for(const request of [{url:'https://evil.example/login.do',method:'GET'},{url:PROFILE.pdiUrl+'/api/now/table/sys_user',method:'POST'},{url:PROFILE.pdiUrl+'/sys.scripts.do',method:'GET'},{url:PROFILE.pdiUrl+'/api/now/table/sys_user',method:'GET'}])assert.equal(f.session.permits(request),false);
  await f.handlers.get('Fetch.requestPaused')({request:{url:'https://evil.example/login.do',method:'GET'},requestId:'redirect',resourceType:'Document'});
  assert.equal(f.requests.at(-1).method,'Fetch.failRequest');await assert.rejects(f.session.signIn(f.login),{code:'BROWSER_INTERACTIVE'});
  const other=await fakeSession(t);await other.session.signIn(other.login);
  await assert.rejects(other.session.read({url:'https://evil.example/api/now/table/sys_user',fields:['sys_id'],limit:1}),{code:'BROWSER_PROTOCOL'});
  await assert.rejects(other.session.read({url:PROFILE.pdiUrl+'/api/now/table/sys_user?sysparm_fields=user_password&sysparm_limit=1',fields:['user_password'],limit:1}),{code:'BROWSER_PROTOCOL'});
});

test('actor changes during browser discovery abort the read session',async t=>{
  const state=goodState(),f=await fakeSession(t,state);await f.session.signIn(f.login);state.actorId=MACHINE;
  await assert.rejects(f.session.read({url:PROFILE.pdiUrl+'/api/now/table/sys_user?sysparm_fields=sys_id&sysparm_limit=2',fields:['sys_id'],limit:2}),{code:'BROWSER_ACTOR'});
});

test('browser evidence must match the exact admin record and remains in approval context',()=>{
  const data=source(),value=snapshot(PROFILE,['itil'],data);assert.equal(value.actor.authMethod,'isolated-browser-session');assert.equal(value.blockers.length,0);
  for(const change of [d=>{d.browserActor.sysId=MACHINE;},d=>{d.browserActor.impersonating=true;},d=>{delete d.browserActor;}]){
    const bad=source();change(bad);assert.ok(snapshot(PROFILE,['itil'],bad).blockers.some(b=>b.code==='actor_mismatch'));
  }
});

test('Basic401 uses fresh browser session and the same bounded helper query definitions',async t=>{
  const directory=await root(t),data=source(),calls=[];let closed=false;
  const responses={actor:data.actor,machine:data.machine,dictionary:data.dictionary,choices:data.choices,roles:data.roles,roleIds:data.existingRoles};
  const session={actor:data.browserActor,async start(){},async close(){closed=true;},async signIn(login){assert.equal((await login({debuggerUrl:'ws://127.0.0.1:9227/devtools/page/owned',sessionDirectory:path.join(directory,'browsers','admin-mock')})).outcome,'submitted');return {outcome:'authenticated'};},async read(spec){return spec.resource==='grants'?(spec.recordId===ADMIN?data.actorGrants:data.machineGrants):responses[spec.resource];}};
  const adapter=new PlatformAdapter({runtimeHome:directory,browserFactory:()=>session,processRunner:async request=>{calls.push({action:request.action,input:request.input});const output=request.action==='ReadOnboarding'?{ok:true,outcome:'unauthorized'}:request.action==='BrowserLogin'?{ok:true,outcome:'submitted'}:{ok:true,...request.input};return {stdout:JSON.stringify(output),exitCode:0};}});
  const result=await adapter.discoverOnboarding(PROFILE,['itil']);assert.equal(result.access,'browser');assert.equal(result.browserActor.sysId,ADMIN);assert.equal(closed,true);
  assert.ok(calls.some(call=>call.action==='BrowserLogin'));assert.ok(calls.some(call=>call.action==='DescribeOnboarding'));assert.ok(calls.every(call=>!Object.keys(call.input).some(key=>/password|token/i.test(key))));
});

test('missing/unreadable/wrong-host protected admin identity never starts browser login',async t=>{
  for(const outcome of ['missing','unreadable','identityMismatch']){
    const directory=await root(t);let opened=false;
    const adapter=new PlatformAdapter({runtimeHome:directory,browserFactory:()=>{opened=true;throw new Error('Browser must not open.');},processRunner:async()=>({stdout:JSON.stringify({ok:true,outcome}),exitCode:0})});
    assert.deepEqual(await adapter.discoverOnboarding(PROFILE,[]),{access:outcome});assert.equal(opened,false);
  }
});

test('GET gate rejects method override and URL/field descriptor tampering',async t=>{
  const f=await fakeSession(t);await f.session.signIn(f.login);
  assert.equal(f.session.permits({url:PROFILE.pdiUrl+'/login.do',method:'GET',headers:{'X-http-method-override':'POST'}}),false);
  assert.equal(f.session.permits({url:PROFILE.pdiUrl+'/scripts/js_includes.jsx',method:'GET'}),true);
  assert.equal(f.session.permits({url:PROFILE.pdiUrl+'/now/nav/ui/classic',method:'GET'}),true);
  for(const url of [PROFILE.pdiUrl+'/api/now/table/sys_user?sysparm_fields=user_password&sysparm_limit=1',PROFILE.pdiUrl+'/api/now/table/sys_user?sysparm_fields=sys_id&sysparm_limit=1&sysparm_query=javascript:gs.anything()',PROFILE.pdiUrl+'/api/now/table/sys_user?sysparm_fields=sys_id&sysparm_limit=1&sysparm_limit=2'])await assert.rejects(f.session.read({url,fields:['sys_id'],limit:1}),{code:'BROWSER_PROTOCOL'});
});
test('optional normal post-login UI-page frame remains denied without misreporting MFA/SSO',async t=>{
 const f=await fakeSession(t);await f.handlers.get('Fetch.requestPaused')({request:{url:PROFILE.pdiUrl+'/ui_page.do?sys_id='+'1'.repeat(32),method:'GET'},requestId:'optional-landing',resourceType:'Document'});
 assert.equal(f.requests.at(-1).method,'Fetch.failRequest');assert.equal(f.session.scopeFailure,null);assert.equal((await f.session.signIn(f.login)).outcome,'authenticated');
 const other=await fakeSession(t);await other.handlers.get('Fetch.requestPaused')({request:{url:PROFILE.pdiUrl+'/ui_page.do?sys_id=not-a-source-id',method:'GET'},requestId:'unrecognized-page',resourceType:'Document'});assert.equal(other.session.scopeFailure.code,'BROWSER_INTERACTIVE');
});

test('cancelled browser start or cancelled/missing credential submission never implies authentication',async t=>{
  const directory=await root(t),controller=new AbortController();controller.abort();
  await assert.rejects(new IsolatedAdminBrowser({runtimeHome:directory,profile:PROFILE,signal:controller.signal}).start(),{code:'CANCELLED'});
  for(const outcome of ['missing','identityMismatch','cancelled']){const f=await fakeSession(t);assert.deepEqual(await f.session.signIn(async()=>({outcome})),{outcome});assert.equal(f.session.actor,null);}
});

test('API/browser discovery share scalar-or-value reference normalization without following links',async t=>{
  const directory=await root(t),adapter=new PlatformAdapter({runtimeHome:directory,processRunner:async()=>({stdout:JSON.stringify({ok:true,...read([{sys_id:'1'.repeat(32),user:{value:ADMIN,link:'https://evil.example/user'},role:{value:ROLE,display_value:'admin',link:'https://evil.example/role'}}])}),exitCode:0})});
  const result=await adapter._pdiRows(PROFILE,'admin','grants',{recordId:ADMIN});assert.equal(result.rows[0].user,ADMIN);assert.equal(result.rows[0].role,ROLE);assert.ok(!JSON.stringify(result).includes('evil.example'));
  assert.throws(()=>adapter._onboardingRows(read([{role:{value:ROLE,password:'PRIVATE_SECRET'}}])),{code:'HELPER_PROTOCOL'});
  assert.throws(()=>adapter._onboardingRows(read([{role:{display_value:'admin'}}])),{code:'HELPER_PROTOCOL'});
});

test('browser fallback failed-login/MFA paths close owned session and retain honest blocked outcomes',async t=>{
  for(const [code,outcome] of [['BROWSER_INTERACTIVE','interactiveRequired'],['BROWSER_LOGIN_FAILED','loginFailed'],['BROWSER_ACTOR','identityMismatch']]){
    const directory=await root(t);let closed=false;
    const adapter=new PlatformAdapter({runtimeHome:directory,browserFactory:()=>({async start(){},async signIn(){throw Object.assign(new Error('PRIVATE_BROWSER_DETAIL'),{code});},async close(){closed=true;}}),processRunner:async()=>({stdout:'{"ok":true,"outcome":"unauthorized"}',exitCode:0})});
    assert.deepEqual(await adapter.discoverOnboarding(PROFILE,[]),{access:outcome});assert.equal(closed,true);
  }
});

async function protectedFixture(adapter, changes={}){
  const input=adapter._credentialInput(PROFILE,'admin');
  const script="$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($v.filePath));$p=ConvertTo-SecureString $v.password -AsPlainText -Force;[pscustomobject]@{InstanceUrl=$v.instanceUrl;User=$v.user;Purpose=$v.purpose;Credential=[pscredential]::new($v.user,$p)}|Export-Clixml -LiteralPath $v.filePath -Depth 5;$p.Dispose();[Console]::Out.WriteLine('fixture-protected')";
  await new Promise((resolve,reject)=>{const child=spawn('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',()=>{});child.once('error',reject);child.once('exit',code=>code===0&&stdout.trim()==='fixture-protected'?resolve():reject(new Error('Mock DPAPI fixture creation failed.')));child.stdin.end(JSON.stringify({...input,...changes,password:'IsolatedFixtureOnly!8492'}));});
  assert.ok(!(await fs.readFile(input.filePath,'utf8')).includes('IsolatedFixtureOnly!8492'));
}

test('real Edge/CDP + protected helper signs in to fulfilled mock form and reads only mock session Table API',async t=>{
  const directory=await root(t),data=source(),requests=new Map(),targetEvents=[];let normalLogin=false,networkContinues=0,postCount=0;
  for(const grants of [data.actorGrants,data.machineGrants])for(const row of grants.rows){row.user={value:row.user};row.role={value:row.role};}
  for(const row of data.dictionary.rows)row.internal_type={value:row.internal_type};
  const adapter=new PlatformAdapter({runtimeHome:directory,scriptRoot:path.resolve(__dirname,'..','scripts')});await protectedFixture(adapter);
  const session=new IsolatedAdminBrowser({runtimeHome:directory,profile:PROFILE,loginTimeoutMs:10000,connectImpl:async url=>{
    const transport=await connectCdp(url);
    return {close:()=>transport.close(),on(method,callback){transport.on(method,params=>{if(method==='Target.attachedToTarget')targetEvents.push({type:params.targetInfo.type,owned:params.targetInfo.targetId===session.pageId});if(method==='Fetch.requestPaused'){
      const request=params.request,u=new URL(request.url);requests.set(params.requestId,{url:u,method:request.method});
      if(request.method==='POST'){postCount++;const body=new URLSearchParams(request.postData||'');normalLogin=body.get('user_name')==='admin'&&body.get('user_password')==='IsolatedFixtureOnly!8492';}
    }callback(params);});},async send(method,params={},sessionId){
      if(method==='Fetch.failRequest') { const denied=requests.get(params.requestId); assert.fail('Mock request was blocked: '+denied?.method+' '+denied?.url.origin+denied?.url.pathname); }
      if(method!=='Fetch.continueRequest')return transport.send(method,params,sessionId);
      const request=requests.get(params.requestId);let body='',headers=[{name:'Content-Type',value:'text/html'}],status=200;
      if(request.url.pathname==='/login.do'&&request.method==='GET')body='<html><body><form action="/login.do" method="post"><input id="user_name" name="user_name"><input id="user_password" name="user_password" type="password"><button id="sysverb_login" type="submit">Login</button></form></body></html>';
      else if(request.url.pathname==='/login.do'&&request.method==='POST'){status=302;headers=[{name:'Location',value:PROFILE.pdiUrl+'/sys_user_list.do'},{name:'Set-Cookie',value:'mock_session=accepted; Path=/; Secure; SameSite=Lax'}];}
      else if(request.url.pathname==='/sys_user_list.do')body='<html><head><script>window.NOW={user:{userID:"'+ADMIN+'",name:"admin",isImpersonating:false}};window.g_ck="mock-session-token";</script></head><body>Mock user list</body></html>';
      else if(request.url.pathname.startsWith('/api/now/table/')){
        headers=[{name:'Content-Type',value:'application/json'}];
        const table=request.url.pathname.split('/').at(-1),query=request.url.searchParams.get('sysparm_query');
        const rows=table==='sys_user'?query==='user_name=admin'?data.actor.rows:data.machine.rows:table==='sys_dictionary'?data.dictionary.rows:table==='sys_choice'?data.choices.rows:table==='sys_user_role'?query.startsWith('nameIN')?data.roles.rows:data.existingRoles.rows:table==='sys_user_has_role'?query==='user='+ADMIN?data.actorGrants.rows:data.machineGrants.rows:null;
        if(!rows)throw new Error('Unexpected mock table.');body=JSON.stringify({result:rows});
      }
      else if (/\.(ico|png|css|js)$/.test(request.url.pathname)) { status=204;body=''; }
      else{networkContinues++;throw new Error('Unexpected mock request route.');}
      return transport.send('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:status,responseHeaders:headers,body:Buffer.from(body).toString('base64')});
    }};
  }});
  try{
    await session.start();const login=await session.signIn(owned=>adapter._helper('credential.ps1','BrowserLogin',{...adapter._credentialInput(PROFILE,'admin'),...owned}));assert.equal(login.outcome,'authenticated');assert.equal(normalLogin,true);assert.equal(postCount,1);
    const spec=await adapter._helper('credential.ps1','DescribeOnboarding',{...adapter._credentialInput(PROFILE,'admin'),resource:'actor'});
    const result=await session.read(spec);assert.equal(result.rows[0].sys_id,ADMIN);assert.equal(networkContinues,0);assert.ok([...requests.values()].every(value=>value.url.origin===PROFILE.pdiUrl));assert.ok(!JSON.stringify(result).includes('IsolatedFixtureOnly'));assert.ok(!JSON.stringify(result).includes('mock-session-token'));
    const discovery=await adapter._collectOnboarding(PROFILE,['itil'],async(resource,options)=>adapter._onboardingRows(await session.read(await adapter._helper('credential.ps1','DescribeOnboarding',{...adapter._credentialInput(PROFILE,'admin'),resource,...options}))),result);
    const plan=snapshot(PROFILE,['itil'],{...discovery,access:'browser',browserActor:session.actor});assert.equal(plan.blockers.length,0);assert.equal(plan.target.sysId,MACHINE);assert.equal(plan.actor.authMethod,'isolated-browser-session');assert.equal(plan.roles[0].sysId,ITIL);assert.equal(plan.sourceChanges.length,0);
    await protectedFixture(adapter,{instanceUrl:'https://dev999.service-now.com'});
    const mismatch=await adapter._helper('credential.ps1','BrowserLogin',{...adapter._credentialInput(PROFILE,'admin'),debuggerUrl:session.debuggerUrl,sessionDirectory:session.directory});
    assert.equal(mismatch.outcome,'identityMismatch');assert.equal(postCount,1);
  }catch(e){throw new Error(e.code+' mock targets '+JSON.stringify(targetEvents)+' trace '+JSON.stringify([...requests.values()].map(r=>({method:r.method,origin:r.url.origin,path:r.url.pathname}))));}finally{await session.close();}
  await assert.rejects(fs.access(session.directory),{code:'ENOENT'});
});
