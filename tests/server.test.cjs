'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {ProfileStore}=require('../lib/profiles.cjs');const {ConfigServer}=require('../lib/server.cjs');
const A='11111111-1111-1111-1111-111111111111',B='22222222-2222-2222-2222-222222222222';
const input={name:'Config A',pdiUrl:'https://dev123.service-now.com',tenantInput:A,adminUser:'admin',integrationUser:'demo_seeder',attestedDemo:true};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'.sn-server-'));const store=new ProfileStore({outputRoot:path.join(root,'output'),runtimeHome:path.join(root,'protected')});const adapter={credentialStatus:async()=>({admin:false,integration:false}),testPdi:async()=>({status:'authenticated',checkedAt:new Date().toISOString(),message:'Read test only.',writeAccessTested:false}),captureCredential:async()=>({saved:false,cancelled:true}),connectMicrosoft:async()=>({tenantId:A,tenantDisplayName:'Demo tenant',authCacheKey:'a'.repeat(64)}),listUsers:async()=>({users:[],nextCursor:null})};const server=new ConfigServer({store,adapter,projectRoot:path.resolve(__dirname,'..')});await server.start();t.after(async()=>{await server.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:250});});const call=async(route,data,extra={})=>{const headers={'X-DemoSeeder-Token':server.token,...extra};if(data!==undefined)headers['Content-Type']='application/json';const res=await fetch(server.origin+route,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)});return {status:res.status,data:await res.json()};};return{server,store,call};}
test('local API requires session token and exact origin',async t=>{const f=await fixture(t);assert.equal((await f.call('/api/state',undefined,{'X-DemoSeeder-Token':'wrong'})).status,401);assert.equal((await f.call('/api/state',undefined,{Origin:'https://evil.example'})).status,403);assert.equal((await f.call('/api/state')).data.profiles.length,0);const response=await fetch(f.server.origin+'/lib/profiles.cjs');assert.equal(response.status,404);});
test('renamed Config Builder uses the new chat command and actual backend storage path',async t=>{const f=await fixture(t),response=await fetch(f.server.origin+'/config-builder.html'),html=await response.text();assert.ok(html.includes('<title>SN DemoLoader'));assert.ok(html.includes("'/sn-demoloader use '"));assert.ok(!html.includes('/sn-demoseeder'));assert.ok(html.includes('state.configDirectory'));assert.ok(!html.includes('SN-DemoSeed-Output\\\\configs'));assert.ok(html.includes('href="./PREREQUISITES.html"'));for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))assert.doesNotThrow(()=>new (require('node:vm').Script)(script[1]));const state=(await f.call('/api/state')).data;assert.equal(state.skillName,'sn-demoloader');assert.equal(state.displayName,'SN DemoLoader');assert.equal(state.storage.configs,f.store.configDir);});
test('saved profiles use real output directory and immutable pairing',async t=>{const f=await fixture(t);const created=await f.call('/api/profiles',input);assert.equal(created.status,200);const profile=created.data.profile;assert.equal(profile.microsoftVerified,false);assert.equal((await fs.readdir(f.store.configDir)).length,1);assert.equal((await f.call('/api/profiles',{...input,name:'changed',id:profile.id,expectedRevision:1,tenantInput:B})).status,409);const exported=await f.call('/api/export?profileId='+profile.id);assert.equal(Object.hasOwn(exported.data.config,'authCacheKey'),false);assert.equal(Object.hasOwn(exported.data.config,'credentials'),false);});
test('one active tenant pairing per PDI is explicit',async t=>{const f=await fixture(t);const a=(await f.call('/api/profiles',input)).data.profile;const b=(await f.call('/api/profiles',{...input,name:'Config B',tenantInput:B})).data.profile;assert.equal((await f.call('/api/select',{profileId:a.id})).status,200);const rejected=await f.call('/api/select',{profileId:b.id});assert.equal(rejected.status,409);assert.equal(rejected.data.code,'transition_required');});
test('read-only jobs complete without claiming write readiness',async t=>{const f=await fixture(t);const p=(await f.call('/api/profiles',input)).data.profile;const started=await f.call('/api/test-pdi',{profileId:p.id,purpose:'integration'});let job;for(let n=0;n<20;n++){job=(await f.call('/api/jobs/'+started.data.jobId)).data.job;if(job.status==='complete')break;await new Promise(r=>setTimeout(r,5));}assert.equal(job.status,'complete');assert.equal(job.result.writeAccessTested,false);assert.equal((await f.call('/api/state')).data.profiles[0].pdiChecks.integration.status,'authenticated');assert.equal((await f.call('/api/seed',{})).status,404);});
test('create-account path saves intent and permits admin setup only',async t=>{const f=await fixture(t);const created=await f.call('/api/profiles',{...input,integrationMode:'create'});assert.equal(created.status,200);const profile=created.data.profile;assert.equal(profile.integrationMode,'create');const exported=await f.call('/api/export?profileId='+profile.id);assert.equal(exported.data.config.integrationMode,'create');for(const route of ['/api/credentials','/api/test-pdi']){const denied=await f.call(route,{profileId:profile.id,purpose:'integration'});assert.equal(denied.status,409);assert.equal(denied.data.code,'provisioning_required');}const started=await f.call('/api/credentials',{profileId:profile.id,purpose:'admin'});assert.equal(started.status,200);let job;for(let n=0;n<200;n++){job=(await f.call('/api/jobs/'+started.data.jobId)).data.job;if(['complete','failed','cancelled'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(job.status,'cancelled');assert.equal((await f.store.state(f.server.adapter)).capabilities.provisioning,false);});
test('initial page contains no embedded credentials and API status is no-store',async t=>{const f=await fixture(t);const res=await fetch(f.server.origin+'/config-builder.html');assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');const text=await res.text();assert.ok(text.includes('config-form'));for(const field of ['password-admin','password-integration']){const element=text.match(new RegExp('<input[^>]*id="'+field+'"[^>]*>'))?.[0];assert.ok(element);assert.ok(!/\bvalue\s*=/.test(element));}});
test('config page provides three linked focused sections and a generic PDI example',async t=>{
  const f=await fixture(t);const response=await fetch(f.server.origin+'/config-builder.html');const text=await response.text();
  assert.equal((text.match(/role="tab"/g)||[]).length,3);assert.equal((text.match(/role="tabpanel"/g)||[]).length,3);
  for(const name of ['pairing','connections','people']){
    const tab=text.match(new RegExp('<button[^>]*id="tab-'+name+'"[^>]*>'))?.[0];
    const panel=text.match(new RegExp('<section[^>]*id="panel-'+name+'"[^>]*>'))?.[0];
    assert.ok(tab?.includes('aria-controls="panel-'+name+'"'));assert.ok(panel?.includes('aria-labelledby="tab-'+name+'"'));
    assert.equal(/\bhidden\b/.test(panel),name!=='pairing');assert.ok(text.includes('id="section-'+name+'-status"'));
  }
  const input=text.match(/<input[^>]*id="pdi-url"[^>]*>/)?.[0];
  assert.ok(input?.includes('placeholder="https://dev123456.service-now.com"'));assert.ok(!/\bvalue=/.test(input));
  assert.ok(!text.includes('id="test-admin"'));assert.ok(text.includes('id="test-integration"'));assert.ok(!text.includes('id="connect-microsoft"'));assert.ok(text.includes('id="manual-person-form"'));assert.ok(text.includes('id="add-another-person"'));assert.ok(text.includes('Microsoft / ServiceNow email'));assert.ok(text.includes('An existing ServiceNow account must match it'));
  assert.ok(text.includes('<h2>Saved configurations</h2>'));assert.ok(text.includes('id="add-config" disabled>New Configuration</button>'));
  const actions=text.match(/<div class="profile-actions">([\s\S]*?)<\/div>/)?.[1];assert.ok(actions);assert.ok(actions.indexOf('id="load-config"')<actions.indexOf('id="add-config"'));
  assert.ok(text.includes('id="pairing-servicenow-logo"'));assert.ok(text.includes('id="pairing-microsoft-logo"'));
  const machine=text.match(/<input[^>]*id="integration-user"[^>]*>/)?.[0];assert.ok(machine?.includes('value="demo.seeder"'));assert.ok(text.includes("saved?.integrationUser || 'demo.seeder'"));assert.ok(text.includes('<code>demo.seeder</code>'));
  assert.ok(text.includes('<option value="admin" id="person-admin-role" disabled>Admin</option>'));assert.ok(text.includes('Admin means full instance access; granting it requires separate approval.'));
  const login=text.match(/<input[^>]*id="person-sn-user"[^>]*>/)?.[0];assert.ok(login?.includes('required'));assert.ok(login?.includes('placeholder="firstname.lastname"'));assert.ok(!text.includes('defaults to the email'));
});
test('API saves and exports only the extracted email domain',async t=>{
 const f=await fixture(t),created=await f.call('/api/profiles',{...input,tenantInput:'person@DEMO.OnMicrosoft.com'});
 assert.equal(created.status,200);assert.equal(created.data.profile.tenantInput,'demo.onmicrosoft.com');assert.equal(created.data.profile.microsoftVerified,false);
 const exported=await f.call('/api/export?profileId='+created.data.profile.id);assert.equal(exported.data.config.tenantInput,'demo.onmicrosoft.com');
 assert.equal((await f.call('/api/profiles',{...input,name:'Custom domain',tenantInput:'person@contoso.com'})).status,400);
});
test('config deletion requires confirmation, current revision, session and idle profile',async t=>{
 const f=await fixture(t),p=(await f.call('/api/profiles',input)).data.profile;
 const payload={profileId:p.id,expectedRevision:p.revision,confirmed:true};
 assert.equal((await f.call('/api/delete-profile',{...payload,confirmed:false})).data.code,'confirmation_required');
 assert.equal((await f.call('/api/delete-profile',payload,{'X-DemoSeeder-Token':'wrong'})).status,401);
 assert.equal((await f.call('/api/delete-profile',{...payload,expectedRevision:2})).data.code,'stale_profile');
 f.server.busy.add(p.id);assert.equal((await f.call('/api/delete-profile',payload)).data.code,'profile_busy');f.server.busy.delete(p.id);
 await f.call('/api/select',{profileId:p.id});assert.equal((await f.call('/api/delete-profile',payload)).status,200);
 assert.equal((await fs.readdir(f.store.configDir)).length,0);assert.equal((await f.call('/api/state')).data.selectedProfileId,null);
 assert.equal((await f.call('/api/delete-profile',payload)).status,404);
});
test('inline credential API is revision-bound, nonsecret and rejects planned accounts',async t=>{
 const f=await fixture(t),p=(await f.call('/api/profiles',input)).data.profile;let calls=0;
 f.server.adapter.saveCredential=async(profile,purpose,password)=>{calls++;assert.equal(profile.id,p.id);assert.equal(purpose,'admin');assert.equal(password,'Synthetic-only!');return {saved:true};};
 const payload={profileId:p.id,expectedRevision:p.revision,purpose:'admin',password:'Synthetic-only!'};
 assert.equal((await f.call('/api/save-credential',{...payload,expectedRevision:12})).data.code,'stale_profile');
 const started=await f.call('/api/save-credential',payload);assert.equal(started.status,200);let job;
 for(let n=0;n<40;n++){job=(await f.call('/api/jobs/'+started.data.jobId)).data.job;if(job.status==='complete')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(job.status,'complete');assert.equal(calls,1);assert.ok(!JSON.stringify(job).includes(payload.password));assert.ok(!(await fs.readFile(require('node:path').join(f.store.configDir,'config-a-config.json'),'utf8')).includes(payload.password));
 const planned=(await f.call('/api/profiles',{...input,name:'Planned',integrationMode:'create'})).data.profile;
 assert.equal((await f.call('/api/save-credential',{...payload,profileId:planned.id,purpose:'integration'})).data.code,'provisioning_required');
});
test('load config requires confirmation and leaves selection/auth unverified',async t=>{
 const f=await fixture(t),config={...input,schemaVersion:1,tenantId:null,people:[]};
 assert.equal((await f.call('/api/load-profile',{config,confirmed:false})).status,409);
 const loaded=await f.call('/api/load-profile',{config,confirmed:true});assert.equal(loaded.status,200);assert.equal(loaded.data.profile.configFileName,'config-a-config.json');assert.equal(loaded.data.profile.microsoftVerified,false);assert.equal((await f.call('/api/state')).data.selectedProfileId,null);
 const exported=await f.call('/api/export?profileId='+loaded.data.profile.id);assert.equal(exported.data.fileName,'config-a-config.json');
});
test('cancel action aborts only the requested job and releases its busy state',async t=>{
 const f=await fixture(t),p=(await f.call('/api/profiles',input)).data.profile;
 let entered;const ready=new Promise(resolve=>{entered=resolve;});
 f.server.adapter.testPdi=async(profile,purpose,{signal})=>new Promise((resolve,reject)=>{const cancel=()=>reject(Object.assign(new Error('cancelled'),{code:'CANCELLED'}));if(signal.aborted){cancel();return;}signal.addEventListener('abort',cancel,{once:true});entered();});
 const started=await f.call('/api/test-pdi',{profileId:p.id,purpose:'admin'});await ready;
 assert.equal((await f.call('/api/jobs/'+started.data.jobId+'/cancel',{})).status,200);
 let job;const deadline=Date.now()+5000;do{job=(await f.call('/api/jobs/'+started.data.jobId)).data.job;if(job.status==='cancelled'&&f.server.busy.size===0)break;await new Promise(r=>setTimeout(r,10));}while(Date.now()<deadline);
 assert.equal(job.status,'cancelled');assert.equal(f.server.busy.size,0);
});
test('manual people API uses declared data only and retired CDX routes do not execute',async t=>{
 const f=await fixture(t),p=(await f.call('/api/profiles',input)).data.profile;
 f.server.adapter.connectMicrosoft=async()=>{throw new Error('Must not sign in.');};f.server.adapter.listUsers=async()=>{throw new Error('Must not read Graph.');};
 assert.equal((await f.call('/api/connect-microsoft',{profileId:p.id})).status,404);assert.equal((await f.call('/api/users?profileId='+p.id)).status,404);
 const person={displayName:'Manual User',email:'person@demo.onmicrosoft.com',serviceNowUserName:'manual.user',accountIntent:'existing',roleProfiles:['requester']};
  const missingLogin={...person};delete missingLogin.serviceNowUserName;assert.equal((await f.call('/api/manual-people',{profileId:p.id,expectedRevision:p.revision,person:missingLogin})).status,400);assert.equal((await f.store.get(p.id)).manualPeople.length,0);
 const added=await f.call('/api/manual-people',{profileId:p.id,expectedRevision:p.revision,person});assert.equal(added.status,200);assert.equal(added.data.sourceWrites,false);assert.equal(added.data.profile.manualPeople.length,1);assert.equal(added.data.profile.microsoftVerified,false);
 assert.equal((await f.call('/api/manual-people',{profileId:p.id,expectedRevision:p.revision,person})).data.code,'stale_profile');
 const exported=await f.call('/api/export?profileId='+p.id);assert.equal(exported.data.config.manualPeople[0].accountIntent,'existing');
 const removed=await f.call('/api/manual-people/remove',{profileId:p.id,expectedRevision:added.data.profile.revision,personId:added.data.profile.manualPeople[0].id});assert.equal(removed.data.profile.manualPeople.length,0);
});
test('Admin plans save and export locally without enabling source provisioning',async t=>{
 const f=await fixture(t),p=(await f.call('/api/profiles',input)).data.profile;
 for(const method of ['testPdi','discoverOnboarding','connectMicrosoft','listUsers'])f.server.adapter[method]=async()=>{throw new Error('Planning must not access the source.');};
 const person={displayName:'Planned Admin',email:'planned@demo.onmicrosoft.com',serviceNowUserName:'planned.admin',accountIntent:'create-if-missing',roleProfiles:['admin']};
 const added=await f.call('/api/manual-people',{profileId:p.id,expectedRevision:p.revision,person});assert.equal(added.status,200);assert.equal(added.data.sourceWrites,false);assert.deepEqual(added.data.profile.manualPeople[0].roleProfiles,['admin']);
 const exported=await f.call('/api/export?profileId='+p.id);assert.deepEqual(exported.data.config.manualPeople[0].roleProfiles,['admin']);
 const state=(await f.call('/api/state')).data;assert.equal(state.capabilities.manualAdminRole,true);assert.equal(state.capabilities.personProvisioning,false);assert.equal(state.capabilities.provisioning,false);assert.equal(state.selectedProfileId,null);assert.deepEqual(await f.store.history(),[]);
});
