'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ProfileStore, atomic } = require('../lib/profiles.cjs');
const { PlatformAdapter } = require('../lib/platform.cjs');
const { Onboarding, snapshot } = require('../lib/onboarding.cjs');
const { ConfigServer } = require('../lib/server.cjs');
const { digest } = require('../lib/execution.cjs');
const TENANT = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'a'.repeat(32), MACHINE = 'b'.repeat(32), ADMIN_ROLE = 'c'.repeat(32), ITIL = 'd'.repeat(32), KNOWLEDGE = 'e'.repeat(32);
const read = rows => ({ outcome: 'readable', rows, truncated: false });
const clone = value => JSON.parse(JSON.stringify(value));
function data() {
  return { access: 'api', actor: read([{ sys_id: ADMIN, user_name: 'admin', active: 'true', identity_type: 'human-instance-value', web_service_access_only: 'false' }]), actorGrants: read([{ sys_id: '1'.repeat(32), user: ADMIN, role: ADMIN_ROLE }]), machine: read([{ sys_id: MACHINE, user_name: 'machine_test', active: 'true', identity_type: 'machine-instance-value', web_service_access_only: 'true' }]), dictionary: read(['user_name','active','identity_type','web_service_access_only'].map((element, i) => ({ sys_id: String(i + 2).repeat(32), name: 'sys_user', element, internal_type: i === 1 || i === 3 ? 'boolean' : 'string', read_only: 'false' }))), choices: read([{ sys_id: '6'.repeat(32), name: 'sys_user', element: 'identity_type', value: 'machine-instance-value', label: 'Machine', inactive: 'false', language: 'en' }]), roles: read([{sys_id: ADMIN_ROLE, name: 'admin'}, {sys_id: ITIL, name: 'itil'}, {sys_id: KNOWLEDGE, name: 'knowledge'}]), machineGrants: read([{sys_id: '7'.repeat(32), user: MACHINE, role: ITIL}, {sys_id: '8'.repeat(32), user: MACHINE, role: KNOWLEDGE}]), existingRoles: read([{sys_id: ITIL, name: 'itil'}, {sys_id: KNOWLEDGE, name: 'knowledge'}]) };
}
async function fixture(t, mode = 'existing') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '.sn-onboarding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProfileStore({ outputRoot: path.join(root, 'output'), runtimeHome: path.join(root, 'protected') });
  const input = { name: 'Isolated pair', pdiUrl: 'https://dev123.service-now.com', tenantInput: TENANT, adminUser: 'admin', integrationUser: 'machine_test', integrationMode: mode, attestedDemo: true };
  let profile = await store.save(input);
  profile = await store.verifyMicrosoft(profile, { tenantId: TENANT, tenantDisplayName: 'Mock demo', authCacheKey: 'a'.repeat(64) });
  await store.select(profile.id);
  const adapter = { credentialStatus: async () => ({admin: false, integration: false}), source: data(), reads: 0, discoverOnboarding: async function () { this.reads++; return clone(this.source); }, verifyMachine: async () => ({status: 'authenticated', sysId: MACHINE, userName: 'machine_test', incident: 'readable', knowledge: 'empty-uncertain', writeAccessTested: false}) };
  const onboarding = new Onboarding({store, adapter});
  return {root, store, input, profile, adapter, onboarding};
}
async function preview(f, roles = ['itil','knowledge']) { return f.onboarding.preview(f.profile.id, f.profile.revision, roles); }
async function approved(f) { const p = await preview(f); return f.onboarding.approve(p.plan.id, p.planHash, true); }

test('canonical context is deeply immutable and hashes ignore object key order', async t => {
  const f = await fixture(t), actor = {sysId: ADMIN, userName:'admin', authMethod:'basic-exact-principal', impersonating:false};
  const context = f.store.makeContext(f.profile, 'onboarding.reuse', {b:2,a:1}, actor);
  assert.equal(context.payloadSha256, digest({a:1,b:2})); assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.actor));
  assert.throws(() => { context.actor.userName = 'other'; });
  assert.notEqual(digest(context), digest({...context, actor: {...actor, sysId: MACHINE}}));
  assert.equal((await f.store.assertContext(context, {a:1,b:2})).id, f.profile.id);
});

test('physical PDI lock coordinates separate stores, profiles, edits, deletion and selection', async t => {
  const f = await fixture(t), other = await f.store.save({...f.input, name:'Other profile'}), different = await f.store.save({...f.input, name:'Other PDI', pdiUrl:'https://dev456.service-now.com'});
  const second = new ProfileStore({outputRoot:f.store.outputRoot, runtimeHome:f.store.runtimeHome});
  let entered, finish;
  const ready = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {finish = resolve;});
  const work = f.store.execute(f.store.makeContext(f.profile,'onboarding.discover',{}), {}, async () => {entered(); await gate;});
  await ready;
  try {
    for (const operation of [second.save({...f.input,id:f.profile.id,expectedRevision:f.profile.revision}), second.save({...f.input,name:'Third profile'}), second.delete(other.id,other.revision), second.select(other.id), second.select(different.id), second.executeLocal(other,'connection-test', async()=>{})]) await assert.rejects(operation,{code:'pdi_busy'});
  } finally {finish(); await work;}
  await second.select(other.id);
  assert.equal((await second.registry()).selectedProfileId,other.id);
  assert.equal((await fs.readdir(f.store.executionLocks.directory)).length,0);
});

test('stale/hash-tampered approvals never read or execute a source change', async t => {
  const f = await fixture(t), p = await preview(f), count = f.adapter.reads;
  await assert.rejects(f.onboarding.approve(p.plan.id,'0'.repeat(64),true),{code:'stale_plan'});
  await assert.rejects(f.onboarding.approve(p.plan.id,p.planHash,false),{code:'approval_required'});
  await f.store.save({...f.input,id:f.profile.id,expectedRevision:f.profile.revision,name:'Changed'});
  await assert.rejects(f.onboarding.approve(p.plan.id,p.planHash,true),{code:'stale_plan'});
  assert.equal(f.adapter.reads,count);
});

test('wrong tenant, selected profile and account actor cannot pass preview/apply', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.assertContext({...f.store.makeContext(f.profile,'onboarding.discover',{}),tenantId:'22222222-2222-2222-2222-222222222222'},{}),{code:'stale_plan'});
  f.adapter.source.actor.rows[0].user_name = 'other';
  const blocked = await preview(f); assert.equal(blocked.status,'blocked'); assert.ok(blocked.plan.payload.blockers.some(b=>b.code==='actor_mismatch'));
  f.adapter.source = data(); const plan = await approved(f); f.adapter.source.actor.rows[0].sys_id = MACHINE;
  const stopped = await f.onboarding.apply(plan.plan.id,plan.planHash); assert.equal(stopped.status,'partial'); assert.equal(stopped.steps.at(-1).outcome,'discovery_changed');
});

test('exact active Machine reuse performs only reads and preserves passwords/roles', async t => {
  const f = await fixture(t), plan = await approved(f);
  assert.deepEqual(plan.plan.payload.sourceChanges,[]); assert.equal(plan.plan.payload.roles.length,2); assert.equal(plan.plan.payload.existingRoles.length,2);
  const done = await f.onboarding.apply(plan.plan.id,plan.planHash);
  assert.equal(done.status,'confirmed'); assert.equal(done.readiness.knowledge,'empty-uncertain'); assert.equal(done.readiness.writes,'not-tested'); assert.equal(done.readiness.connector,'unknown');
  assert.equal((await f.store.localInfo(f.profile)).pdiChecks.integration.writeAccessTested,false);
  const restored = new Onboarding({store:f.store,adapter:f.adapter}); assert.equal((await restored.statusForProfile(f.profile.id)).status,'confirmed');
  const count=f.adapter.reads; await restored.apply(plan.plan.id,plan.planHash); assert.equal(f.adapter.reads,count);
  assert.equal((await f.store.history())[0].scenario,'onboarding.reuse'); assert.equal((await f.store.get(f.profile.id)).revision,f.profile.revision);
});
test('ServiceNow-only onboarding works with an explicit unverified Microsoft pairing',async t=>{
 const f=await fixture(t),registry=await f.store.registry();delete registry.checks[f.profile.id];await atomic(f.store.registryFile,registry);
 const declared=await f.store.get(f.profile.id);const updated=await f.store.save({...f.input,id:declared.id,expectedRevision:declared.revision});
 const context=f.store.makeContext(updated,'onboarding.discover',{});assert.equal((await f.store.assertContext(context,{})).id,updated.id);
 const plan=await f.onboarding.preview(updated.id,updated.revision,[]);assert.equal(plan.status,'preview');assert.equal((await f.store.localInfo(updated)).microsoftVerified,false);
 await assert.rejects(f.store.assertContext(f.store.makeContext(updated,'incident.create',{}),{}),{code:'not_ready'});
});

test('API401 is not unavailable admin or inferred browser success; interactive/MFA stays blocked', async t => {
  const f = await fixture(t);
  for (const access of ['unauthorized','interactiveRequired','missing','identityMismatch','unreadable']) {
    f.adapter.source = {access}; const p = await preview(f); assert.equal(p.status,'blocked'); assert.equal(p.plan.payload.actor,null);
    assert.equal(p.plan.payload.blockers[0].code,access); await assert.rejects(f.onboarding.approve(p.plan.id,p.planHash,true));
    if(access==='unauthorized') assert.match(p.plan.payload.blockers[0].message,/Browser login may still work/);
    if(access==='interactiveRequired') assert.match(p.plan.payload.blockers[0].message,/MFA/);
  }
});

test('missing identity fields, installed roles and ambiguous choice values block safely', async t => {
  const f = await fixture(t);
  for (const change of [d=>d.dictionary.rows.pop(), d=>d.choices.rows.push(clone(d.choices.rows[0])), d=>d.roles.rows.splice(1,1), d=>{d.choices.rows[0].label='Human';}, d=>{d.machine.rows[0].active='false';}, d=>{d.machine.rows[0].identity_type='human-instance-value';}, d=>{d.machine.rows[0].web_service_access_only='false';}, d=>{d.machineGrants.truncated=true;}]) {
    f.adapter.source=data();change(f.adapter.source);const p=await preview(f);assert.equal(p.status,'blocked');assert.ok(p.plan.payload.blockers.length);
  }
  await assert.rejects(preview(f,['admin']),/No automatic admin/);
});

test('missing/partial existing grants require manual repair, never automatic grants', async t => {
  const f=await fixture(t);f.adapter.source.machineGrants.rows.pop();f.adapter.source.existingRoles.rows.pop();
  const p=await preview(f);assert.equal(p.status,'blocked');assert.ok(p.plan.payload.blockers.some(b=>b.code==='roles_require_manual_repair'));assert.deepEqual(p.plan.payload.sourceChanges,[]);
});

test('create preview requires creation schema and a supported writer before approval', async t => {
  const f=await fixture(t,'create');f.adapter.source.machine=read([]);f.adapter.source.machineGrants=null;f.adapter.source.existingRoles=null;
  const p=await preview(f);assert.equal(p.status,'blocked');assert.equal(p.plan.payload.proposedFields.identity_type,'machine-instance-value');assert.equal(p.plan.payload.proposedFields.web_service_access_only,true);assert.equal(p.plan.payload.sourceChanges.length,0);assert.ok(p.plan.payload.blockers.some(b=>b.code==='creation_schema_missing'));
  assert.ok(p.plan.payload.blockers.some(b=>b.code==='creation_unsupported'));await assert.rejects(f.onboarding.approve(p.plan.id,p.planHash,true));await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash),{code:'approval_required'});
  assert.equal((await f.store.state(f.adapter)).capabilities.onboardingCreate,false);assert.equal((await f.store.get(f.profile.id)).integrationMode,'create');
});

test('duplicate/new collision is never silently adopted even after preview', async t => {
  const f=await fixture(t), p=await approved(f);f.adapter.source.machine.rows[0].sys_id='9'.repeat(32);
  assert.equal((await f.onboarding.apply(p.plan.id,p.planHash)).status,'partial');
  f.adapter.source=data();f.adapter.source.machine.rows.push(clone(f.adapter.source.machine.rows[0]));assert.equal((await preview(f)).plan.payload.blockers.at(-1).code,'duplicate_collision');
  const fresh=await fixture(t,'create');const existing=await preview(fresh);assert.equal(existing.plan.payload.mode,'reuse');assert.deepEqual(existing.plan.payload.sourceChanges,[]);assert.deepEqual(existing.plan.payload.blockers,[]);
});

test('interrupted read is durable uncertain and reconciles without blind retries or writes', async t => {
  const f=await fixture(t), p=await approved(f);let attempts=0;
  f.adapter.verifyMachine=async()=>{attempts++;throw Object.assign(new Error('NEVER_LOG_THIS_RESPONSE'), {code:'PDI_NETWORK'});};
  const uncertain=await f.onboarding.apply(p.plan.id,p.planHash);assert.equal(uncertain.status,'uncertain');assert.equal(uncertain.steps.at(-1).status,'uncertain');
  await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash),{code:'reconciliation_required'});assert.equal(attempts,1);
  f.adapter.verifyMachine=async()=>({status:'authenticated',incident:'readable',knowledge:'readable',writeAccessTested:false});
  const result=await f.onboarding.apply(p.plan.id,p.planHash,{reconcile:true});assert.equal(result.status,'confirmed');assert.equal(result.steps.at(-1).name,'reconciliation');
  assert.ok(!(await fs.readFile(f.onboarding.file(p.plan.id),'utf8')).includes('NEVER_LOG_THIS_RESPONSE'));
});

test('plan corruption and unexpected helper fields cannot leak plaintext into previews or journals', async t => {
  const f=await fixture(t);f.adapter.source.actor.rows[0].password='MOCK_SECRET_NOT_PERSISTED';f.adapter.source.machine.rows[0].user_password='MOCK_SECRET_NOT_PERSISTED';
  const p=await preview(f);assert.ok(!JSON.stringify(p).includes('MOCK_SECRET_NOT_PERSISTED'));assert.ok(!(await fs.readFile(f.onboarding.file(p.plan.id),'utf8')).includes('MOCK_SECRET_NOT_PERSISTED'));
  const tampered=clone(p);tampered.plan.payload.target.sysId='9'.repeat(32);await atomic(f.onboarding.file(p.plan.id),tampered);await assert.rejects(f.onboarding.status(p.plan.id),{code:'plan_corrupt'});
});

test('bounded platform helper uses same host/user/purpose secret association, no secret arguments', async t => {
  const f=await fixture(t);const calls=[];
  const runner=async request=>{calls.push(request);return {stdout:JSON.stringify({ok:true,outcome:'identityMismatch'}),exitCode:0};};
  const adapter=new PlatformAdapter({runtimeHome:path.join(f.root,'mock-secrets'),processRunner:runner});
  assert.deepEqual(await adapter.discoverOnboarding(f.profile,[]),{access:'identityMismatch'});
  assert.equal(calls[0].action,'ReadOnboarding');assert.equal(calls[0].input.user,'admin');assert.equal(calls[0].input.instanceUrl,f.profile.pdiUrl);assert.equal(calls[0].input.purpose,'admin');assert.ok(!Object.keys(calls[0].input).some(key=>/password|token/i.test(key)));
  const result=await adapter.verifyMachine(f.profile,MACHINE,{identityType:'machine-instance-value'});assert.equal(result.status,'blocked');assert.equal(calls.at(-1).input.purpose,'integration');
});

test('Machine helper rejects wrong account, Human or browser-eligible identity before source reads', async t=>{
  const f=await fixture(t);
  for(const change of [r=>{r.sys_id=ADMIN;},r=>{r.identity_type='human-instance-value';},r=>{r.web_service_access_only='false';}]){
    let calls=0;const actor=clone(data().machine.rows[0]);change(actor);
    const adapter=new PlatformAdapter({runtimeHome:path.join(f.root,'mock-machine'),processRunner:async()=>{calls++;return {stdout:JSON.stringify({ok:true,outcome:'readable',rows:[actor],truncated:false}),exitCode:0};}});
    const result=await adapter.verifyMachine(f.profile,MACHINE,{identityType:'machine-instance-value'});assert.equal(result.status,'blocked');assert.equal(calls,1);
  }
});

test('expired preview and changed account mode cannot reuse previous approval evidence', async t=>{
  const f=await fixture(t),p=await preview(f);
  const expired=clone(p);expired.plan.expiresAt='2020-01-01T00:00:00.000Z';expired.planHash=digest(expired.plan);await atomic(f.onboarding.file(p.plan.id),expired);
  await assert.rejects(f.onboarding.approve(p.plan.id,expired.planHash,true),{code:'stale_plan'});
  const fresh=await approved(f);await f.store.save({...f.input,id:f.profile.id,expectedRevision:f.profile.revision,integrationMode:'create'});
  await assert.rejects(f.onboarding.apply(fresh.plan.id,fresh.planHash),{code:'stale_plan'});
});

test('context execution snapshots mutable caller payload and rejects wrong selected pairing',async t=>{
  const f=await fixture(t),payload={fields:{active:true}},context=f.store.makeContext(f.profile,'onboarding.discover',payload);
  const running=f.store.execute(context,payload,async(current,lease,approvedPayload,approvedContext)=>{assert.ok(Object.isFrozen(approvedPayload.fields));assert.equal(approvedPayload.fields.active,true);assert.equal(approvedContext.payloadSha256,digest(approvedPayload));});
  payload.fields.active=false;await running;
  const other=await f.store.save({...f.input,name:'Selected elsewhere',pdiUrl:'https://dev456.service-now.com'});await f.store.select(other.id);
  await assert.rejects(preview(f),{code:'wrong_pair'});
});

test('durable attempting read resumes only through explicit reconciliation',async t=>{
  const f=await fixture(t),p=await approved(f),attempting=clone(p);attempting.status='attempting';attempting.steps.push({name:'reuse-verification',status:'attempting'});await atomic(f.onboarding.file(p.plan.id),attempting);
  const fresh=new Onboarding({store:f.store,adapter:f.adapter});await assert.rejects(fresh.apply(p.plan.id,p.planHash),{code:'reconciliation_required'});
  assert.equal((await fresh.apply(p.plan.id,p.planHash,{reconcile:true})).status,'confirmed');
});

test('protocol, programming, validation and storage errors are journaled and propagated, never swallowed',async t=>{
  for(const [original,expected] of [['HELPER_PROTOCOL','onboarding_protocol_error'],['verification_invalid','onboarding_protocol_error'],['metadata_invalid','onboarding_validation_error'],['EPERM','onboarding_storage_error'],[null,'onboarding_internal_error']]){
    const f=await fixture(t),p=await approved(f);
    f.adapter.verifyMachine=async()=>{const e=new TypeError('PRIVATE_RESPONSE_MUST_NOT_ESCAPE');if(original)e.code=original;throw e;};
    await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash),e=>e.code===expected&&!e.message.includes('PRIVATE_RESPONSE'));
    const state=await f.onboarding.status(p.plan.id);assert.equal(state.status,'failed');assert.equal(state.steps.at(-1).failureCode,expected);assert.equal(state.readiness,null);assert.ok(!JSON.stringify(state).includes('PRIVATE_RESPONSE'));
    await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash,{reconcile:true}),{code:'reconciliation_required'});
  }
});

test('attempting/failure journal storage errors propagate safely and never report success',async t=>{
  const before=await fixture(t),plan=await approved(before),reads=before.adapter.reads;
  before.onboarding.persist=async()=>{throw Object.assign(new Error('PRIVATE_DISK_DETAIL'),{code:'ENOSPC'});};
  await assert.rejects(before.onboarding.apply(plan.plan.id,plan.planHash),e=>e.code==='onboarding_storage_error'&&!e.message.includes('PRIVATE_DISK_DETAIL'));
  assert.equal(before.adapter.reads,reads);
  const after=await fixture(t),other=await approved(after),persist=after.onboarding.persist.bind(after.onboarding);
  after.adapter.verifyMachine=async()=>{throw Object.assign(new Error('PRIVATE_PROTOCOL_DETAIL'),{code:'HELPER_PROTOCOL'});};
  after.onboarding.persist=async state=>{if(state.status==='failed')throw Object.assign(new Error('PRIVATE_DISK_DETAIL'),{code:'EIO'});return persist(state);};
  await assert.rejects(after.onboarding.apply(other.plan.id,other.planHash),e=>e.code==='onboarding_storage_error'&&e.message.includes('onboarding_protocol_error')&&!e.message.includes('PRIVATE_'));
  assert.equal((await after.onboarding.status(other.plan.id)).status,'attempting');
});

test('cancellation alone is safely journaled as uncertainty',async t=>{
  const f=await fixture(t),p=await approved(f);f.adapter.verifyMachine=async()=>{throw Object.assign(new Error('PRIVATE_CANCELLATION'),{code:'CANCELLED'});};
  const state=await f.onboarding.apply(p.plan.id,p.planHash);assert.equal(state.status,'uncertain');assert.equal(state.steps.at(-1).failureCode,'onboarding_cancelled');assert.ok(!JSON.stringify(state).includes('PRIVATE_CANCELLATION'));
});

test('CLI cannot split execution authority into a synced or alternate runtime',async t=>{
  const f=await fixture(t),{spawnSync}=require('node:child_process');
  const result=spawnSync(process.execPath,[path.resolve(__dirname,'..','scripts','cli.cjs'),'profiles','--runtime',path.join(f.root,'alternate')],{encoding:'utf8',env:{...process.env,LOCALAPPDATA:path.join(f.root,'mock-localappdata')}});
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr.trim()).code,'runtime_unsafe');assert.equal(result.stdout,'');
  await assert.rejects(fs.access(path.join(f.root,'alternate')),{code:'ENOENT'});
});

test('guarded API exposes preview, separate approval, verification and restored status; create route absent', async t=>{
  const f=await fixture(t),server=new ConfigServer({store:f.store,adapter:f.adapter,projectRoot:path.resolve(__dirname,'..')});await server.start();t.after(()=>server.close());
  const call=async(route,body)=>{const response=await fetch(server.origin+route,{method:body?'POST':'GET',headers:{'X-DemoSeeder-Token':server.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  const job=async id=>{for(let n=0;n<100;n++){const value=(await call('/api/jobs/'+id)).data.job;if(['complete','failed','cancelled'].includes(value.status))return value;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Mock job did not finish.');};
  assert.equal((await call('/api/onboarding/create',{profileId:f.profile.id})).status,404);
  const started=await call('/api/onboarding/preview',{profileId:f.profile.id,expectedRevision:f.profile.revision,roles:['itil']});assert.equal(started.status,200);const p=(await job(started.data.jobId)).result.onboarding;assert.equal(p.status,'preview');
  assert.equal((await call('/api/onboarding/approve',{planId:p.plan.id,planHash:p.planHash,confirmed:false})).status,409);
  assert.equal((await call('/api/onboarding/approve',{planId:p.plan.id,planHash:p.planHash,confirmed:true})).status,200);
  const apply=await call('/api/onboarding/apply',{planId:p.plan.id,planHash:p.planHash});assert.equal((await job(apply.data.jobId)).result.onboarding.status,'confirmed');
  const status=await call('/api/onboarding/status?profileId='+f.profile.id);assert.equal(status.data.onboarding.status,'confirmed');
  const html=await (await fetch(server.origin+'/config-builder.html')).text();for(const id of ['onboarding-discover','onboarding-approve','onboarding-apply','onboarding-reconcile'])assert.ok(html.includes('id="'+id+'"'));assert.equal((html.match(/type="password"/g)||[]).length,2);assert.ok(html.includes('id="password-admin"'));
});

async function creationFixture(t) {
  const f=await fixture(t,'create');
  f.adapter.source.machine=read([]);f.adapter.source.machineGrants=null;f.adapter.source.existingRoles=null;
  for(const field of f.adapter.source.dictionary.rows){field.unique=field.element==='user_name'?'true':'false';field.max_length='120';}
  f.adapter.source.dictionary.rows.push(...['source','user_password','password_needs_reset'].map((element,i)=>({sys_id:(i+9).toString(16).repeat(32),name:'sys_user',element,internal_type:element==='user_password'?'password2':element==='password_needs_reset'?'boolean':'string',read_only:'false',max_length:'255'})));
  f.calls=[];
  f.adapter.machineOperation=async(profile,action,plan,options={})=>{
    f.calls.push(action);const fields=plan.payload.proposedFields;
    if(action==='PrepareMachineSecret')return {outcome:'prepared'};
    if(action==='PromoteMachineSecret')return {outcome:'promoted'};
    const journal=await f.onboarding.load(plan.id);assert.equal(journal.status,'attempting');assert.equal(journal.sourceWrites,true);assert.ok(journal.steps.some(step=>step.write&&step.status==='attempting'));
    if(action==='CreateMachine'){
      f.adapter.source.machine=read([{...fields,active:'true',web_service_access_only:'true'}]);f.adapter.source.machineGrants=read([]);f.adapter.source.existingRoles=read([]);
      return {outcome:'created',row:clone(f.adapter.source.machine.rows[0])};
    }
    if(action==='CreateMachineRole'){
      const row={sys_id:options.grantId,user:fields.sys_id,role:options.role.sysId};
      f.adapter.source.machineGrants.rows.push(row);f.adapter.source.existingRoles.rows.push({sys_id:options.role.sysId,name:options.role.name});
      return {outcome:'created',row:clone(row)};
    }
    throw new Error('Unexpected mocked action.');
  };
  f.adapter.verifyMachine=async(profile,expected)=>({status:'authenticated',sysId:expected,userName:profile.integrationUser,incident:'readable',knowledge:'empty-uncertain',writeAccessTested:false});
  return f;
}
test('approved missing Machine creation stages a credential, writes exact owned records and persists mapping',async t=>{
  const f=await creationFixture(t),p=await preview(f,['itil']);assert.equal(p.status,'preview');assert.equal(p.plan.payload.mode,'create');assert.equal(p.plan.payload.proposedFields.source,'SN-DemoSeeder:'+p.plan.id);assert.equal(p.plan.payload.sourceChanges.length,2);assert.ok(!Object.hasOwn(p.plan.payload.proposedFields,'user_password'));
  await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash),{code:'approval_required'});
  await assert.rejects(f.onboarding.approve(p.plan.id,p.planHash,false),{code:'approval_required'});
  await f.onboarding.approve(p.plan.id,p.planHash,true);const done=await f.onboarding.apply(p.plan.id,p.planHash);
  assert.equal(done.status,'confirmed');assert.equal(done.mapping.sysId,p.plan.payload.proposedFields.sys_id);assert.equal(done.mapping.ownership,'created-by-this-operation');assert.equal(done.readiness.connector,'unknown');assert.deepEqual(f.calls,['PrepareMachineSecret','CreateMachine','CreateMachineRole','PromoteMachineSecret']);
  assert.equal((await f.store.get(f.profile.id)).revision,f.profile.revision);assert.equal(await f.onboarding.existingTarget(f.profile),true);
  const length=f.calls.length;await f.onboarding.apply(p.plan.id,p.planHash);assert.equal(f.calls.length,length);
  const history=JSON.parse(await fs.readFile(path.join(f.store.runDir,p.plan.id,'run.json'),'utf8'));assert.equal(history.sourceWrites,true);assert.equal(history.mapping.sysId,done.mapping.sysId);
});
test('create metadata, direct admin API, uniqueness and installed roles must all be proven',async t=>{
  for(const change of [d=>{d.dictionary.rows[0].unique='false';},d=>{d.dictionary.rows[0].max_length='2';},d=>{d.dictionary.rows.find(row=>row.element==='source').read_only='true';},d=>{d.dictionary.rows.find(row=>row.element==='user_password').internal_type='string';},d=>{d.dictionary.rows.pop();},d=>{d.machine.truncated=true;},d=>{d.machine.outcome='forbidden';},d=>{d.actor.rows[0].user_name='other';},d=>{d.roles.rows=d.roles.rows.filter(row=>row.name!=='itil');},d=>{d.access='browser';d.browserActor={sysId:ADMIN,userName:'admin',authMethod:'isolated-browser-session',impersonating:false};}]){
    const f=await creationFixture(t);change(f.adapter.source);const p=await preview(f,['itil']);assert.equal(p.status,'blocked');await assert.rejects(f.onboarding.approve(p.plan.id,p.planHash,true));assert.deepEqual(f.calls,[]);
  }
});
test('Create mode reuses a valid existing Machine without secret generation or role changes',async t=>{
  const f=await creationFixture(t);f.adapter.source=data();const p=await preview(f,['itil']);assert.equal(p.plan.payload.mode,'reuse');assert.deepEqual(p.plan.payload.sourceChanges,[]);await f.onboarding.approve(p.plan.id,p.planHash,true);assert.equal((await f.onboarding.apply(p.plan.id,p.planHash)).status,'confirmed');assert.deepEqual(f.calls,[]);
});
test('collision or actor/config drift before creation cannot be adopted or written',async t=>{
  for(const drift of ['collision','actor','config']){
    const f=await creationFixture(t),p=await preview(f,[]);await f.onboarding.approve(p.plan.id,p.planHash,true);
    if(drift==='collision')f.adapter.source.machine=data().machine;
    if(drift==='actor')f.adapter.source.actor.rows[0].sys_id=MACHINE;
    if(drift==='config')await f.store.save({...f.input,id:f.profile.id,expectedRevision:f.profile.revision,name:'Changed'});
    await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash));assert.deepEqual(f.calls,[]);
  }
});
test('lost creation response is read-only reconciled by owned ID and marker, never blindly re-POSTed',async t=>{
  const f=await creationFixture(t),normal=f.adapter.machineOperation;
  f.adapter.machineOperation=async(...args)=>{const result=await normal(...args);return args[1]==='CreateMachine'?{outcome:'uncertain'}:result;};
  const p=await preview(f,['itil']);await f.onboarding.approve(p.plan.id,p.planHash,true);const uncertain=await f.onboarding.apply(p.plan.id,p.planHash);assert.equal(uncertain.status,'uncertain');
  await assert.rejects(preview(f,[]),{code:'reconciliation_required'});await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash),{code:'reconciliation_required'});
  const count=f.calls.length,reconciled=await f.onboarding.apply(p.plan.id,p.planHash,{reconcile:true});assert.equal(reconciled.status,'partial');assert.equal(f.calls.length,count);assert.equal(reconciled.steps.find(step=>step.name==='machine-create').status,'confirmed');
  await f.onboarding.approve(p.plan.id,p.planHash,true);const done=await f.onboarding.apply(p.plan.id,p.planHash);assert.equal(done.status,'confirmed');assert.equal(f.calls.filter(action=>action==='CreateMachine').length,1);
});
test('uncertain absent or foreign account blocks new plans and does not reset or recreate',async t=>{
  for(const foreign of [false,true]){
    const f=await creationFixture(t),normal=f.adapter.machineOperation;
    f.adapter.machineOperation=async(...args)=>args[1]==='CreateMachine'?(f.calls.push('CreateMachine'),{outcome:'uncertain'}):normal(...args);
    const p=await preview(f,[]);await f.onboarding.approve(p.plan.id,p.planHash,true);await f.onboarding.apply(p.plan.id,p.planHash);
    if(foreign)f.adapter.source.machine=read([{...p.plan.payload.proposedFields,source:'unrelated',sys_id:MACHINE}]);
    const count=f.calls.length,stopped=await f.onboarding.apply(p.plan.id,p.planHash,{reconcile:true});assert.equal(stopped.status,'uncertain');assert.equal(f.calls.length,count);await assert.rejects(preview(f,[]),{code:'reconciliation_required'});
  }
});
test('uncertain role result reconciles exact grant identity before separately approved resume',async t=>{
  const f=await creationFixture(t),normal=f.adapter.machineOperation;
  f.adapter.machineOperation=async(...args)=>{const result=await normal(...args);return args[1]==='CreateMachineRole'?{outcome:'uncertain'}:result;};
  const p=await preview(f,['itil']);await f.onboarding.approve(p.plan.id,p.planHash,true);assert.equal((await f.onboarding.apply(p.plan.id,p.planHash)).status,'uncertain');
  const count=f.calls.length;assert.equal((await f.onboarding.apply(p.plan.id,p.planHash,{reconcile:true})).status,'partial');assert.equal(f.calls.length,count);
  await f.onboarding.approve(p.plan.id,p.planHash,true);assert.equal((await f.onboarding.apply(p.plan.id,p.planHash)).status,'confirmed');assert.equal(f.calls.filter(action=>action==='CreateMachineRole').length,1);
});
test('credential staging failure and attempting journal failure stop before source creation',async t=>{
  const f=await creationFixture(t),p=await preview(f,[]);await f.onboarding.approve(p.plan.id,p.planHash,true);
  f.adapter.machineOperation=async()=>{throw Object.assign(new Error('protected staging failed'),{code:'MACHINE_SECRET_EXISTS'});};
  await assert.rejects(f.onboarding.apply(p.plan.id,p.planHash),{code:'MACHINE_SECRET_EXISTS'});assert.equal((await f.onboarding.status(p.plan.id)).sourceWrites,false);
  const second=await creationFixture(t),next=await preview(second,[]);await second.onboarding.approve(next.plan.id,next.planHash,true);
  const persist=second.onboarding.persist.bind(second.onboarding);second.onboarding.persist=async state=>{if(state.steps.some(step=>step.write&&step.status==='attempting'))throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return persist(state);};
  await assert.rejects(second.onboarding.apply(next.plan.id,next.planHash));assert.deepEqual(second.calls,['PrepareMachineSecret']);
});
