'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {ProfileStore,pdi,tenant,atomic,hostKey,configFilename}=require('../lib/profiles.cjs');
const A='11111111-1111-1111-1111-111111111111',B='22222222-2222-2222-2222-222222222222';
function input(name='Config A',tenantInput=A,pdiUrl='https://dev123.service-now.com'){return {name,pdiUrl,tenantInput,adminUser:'admin',integrationUser:'demo_seeder',attestedDemo:true};}
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'.sn-profiles-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new ProfileStore({outputRoot:path.join(dir,'output'),runtimeHome:path.join(dir,'local')});await store.initialize();return store;}
const adapter={credentialStatus:async()=>({admin:false,integration:false})};
test('canonical PDI and demo-only tenant inputs',()=>{assert.equal(pdi('https://dev123.service-now.com/'),'https://dev123.service-now.com');for(const v of ['http://dev123.service-now.com','https://user:pw@dev123.service-now.com','https://dev123.service-now.com:8443','https://dev123.service-now.com/path','https://dev123.service-now.com?q=x','https://evil.example'])assert.throws(()=>pdi(v));assert.throws(()=>tenant('72f988bf-86f1-41af-91ab-2d7cd011db47'));assert.equal(tenant('demo.onmicrosoft.com'),'demo.onmicrosoft.com');});
test('saved configs reload and have no authentication authority',async t=>{const s=await fixture(t),p=await s.save(input());const fresh=new ProfileStore({outputRoot:s.outputRoot,runtimeHome:s.runtimeHome});assert.equal((await fresh.resolve('config a')).id,p.id);assert.equal((await fresh.view(p,adapter)).microsoftVerified,false);assert.equal((await fs.readdir(s.configDir)).length,1);assert.equal((await fs.readdir(s.runDir)).length,0);});
test('alias collision and stale save rejected',async t=>{const s=await fixture(t),p=await s.save(input());await assert.rejects(s.save(input('config a')),/exists/);await assert.rejects(s.save({...input(),id:p.id,expectedRevision:0}),/changed/);await assert.rejects(s.save({...input('renamed',B),id:p.id,expectedRevision:1}),/immutable/);await assert.rejects(s.save({...input(),password:'not-permitted'}),/Unexpected/);});
test('same PDI cannot select conflicting tenant config',async t=>{const s=await fixture(t),p=await s.save(input()),other=await s.save(input('Config B',B));await s.select(p.id);await assert.rejects(s.select(other.id),e=>e.code==='transition_required');const different=await s.save(input('Config C',B,'https://dev456.service-now.com'));await s.select(different.id);assert.equal((await s.registry()).selectedProfileId,different.id);});
test('context bound to profile revision, pairing and payload',async t=>{const s=await fixture(t),p=await s.save(input());const verified=await s.verifyMicrosoft(p,{tenantId:A,tenantDisplayName:'Demo tenant',authCacheKey:'a'.repeat(64)});await s.select(verified.id);const payload={short_description:'Example'},context=s.makeContext(verified,'incident.create',payload);assert.equal((await s.assertContext(context,payload)).id,p.id);await assert.rejects(s.assertContext(context,{short_description:'Changed'}),/context changed/);await s.save({...input('Renamed'),id:p.id,expectedRevision:verified.revision});await assert.rejects(s.assertContext(context,payload),/context changed/);});
test('connection checks do not imply source writes or survive identity edits',async t=>{const s=await fixture(t),p=await s.save(input());await s.recordCheck(p,'integration',{status:'authenticated',checkedAt:new Date().toISOString(),writeAccessTested:false});assert.equal((await s.localInfo(p)).pdiChecks.integration.writeAccessTested,false);const changed=await s.save({...input(),integrationUser:'another_machine',id:p.id,expectedRevision:p.revision});assert.equal((await s.localInfo(changed)).pdiChecks.integration,null);});
test('corrupted state and controller locks fail closed',async t=>{const s=await fixture(t);await fs.writeFile(s.registryFile,'invalid JSON');await assert.rejects(s.registry(),/malformed/);await fs.unlink(s.registryFile);await fs.writeFile(s.lockFile,'other-controller');await assert.rejects(s.save(input()),e=>e.code==='controller_busy');await fs.unlink(s.lockFile);const results=await Promise.allSettled([s.save(input()),s.save(input())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);});
test('persona selection is planned only and verified per tenant',async t=>{const s=await fixture(t),p=await s.save(input());const u={id:'33333333-3333-3333-3333-333333333333',displayName:'Avery',userPrincipalName:'avery@demo.example',mail:null,accountEnabled:true};await assert.rejects(s.addPerson(p,u,['requester']),/Verify/);const verified=await s.verifyMicrosoft(p,{tenantId:A,tenantDisplayName:'Demo',authCacheKey:'a'.repeat(64)});const added=await s.addPerson(verified,u,['support','knowledge-author']);assert.equal(added.people.length,1);assert.equal(added.people[0].tenantId,A);assert.equal(Object.hasOwn(added.people[0],'serviceNowUserId'),false);await assert.rejects(s.addPerson(added,u,['admin']),/valid/);});
test('planned new Machine account config saves without existing credentials',async t=>{
 const s=await fixture(t),p=await s.save({...input('Fresh PDI'),integrationMode:'create'});assert.equal(p.integrationMode,'create');assert.equal((await s.view(p,adapter)).credentials.integration,false);assert.equal((await s.resolve('Fresh PDI')).integrationMode,'create');await assert.rejects(s.save({...input('Invalid'),integrationMode:'admin'}),/Choose/);
 const old=await s.save(input('Legacy')),file=path.join(s.configDir,configFilename(old.name)),legacy=path.join(s.configDir,old.id+'.json');
 const raw=JSON.parse(await fs.readFile(file,'utf8'));delete raw.integrationMode;await fs.writeFile(file,JSON.stringify(raw));await fs.rename(file,legacy);
 assert.equal((await s.get(old.id)).integrationMode,undefined);const updated=await s.save({...input('Legacy'),id:old.id,expectedRevision:old.revision});assert.equal(updated.integrationMode,'existing');await assert.rejects(fs.access(legacy),{code:'ENOENT'});assert.ok(await fs.stat(file));
});
test('changing account setup choice invalidates stale connection checks',async t=>{const s=await fixture(t),p=await s.save(input());await s.recordCheck(p,'integration',{status:'authenticated',checkedAt:new Date().toISOString(),writeAccessTested:false});const changed=await s.save({...input(),integrationMode:'create',id:p.id,expectedRevision:p.revision});assert.equal((await s.localInfo(changed)).pdiChecks.integration,null);});
test('menu advertises only implemented work and no reseed',async t=>{const s=await fixture(t),menu=await s.menu(adapter);assert.equal(menu.profileCount,0);assert.equal(menu.readiness.seeding,'not-implemented');assert.equal(menu.menu.length,4);assert.ok(menu.menu.some(item=>item.title==='Load HR knowledge pack'));assert.ok(!menu.menu.some(m=>/re-seed|clean up|build.*seed/i.test(m.title)));});
test('demo-user emails normalize to the demo domain, not verified identity',()=>{
 for(const value of ['Person@DEMO.OnMicrosoft.com',' person.one+demo@demo.onmicrosoft.com '])assert.equal(tenant(value),'demo.onmicrosoft.com');
 for(const value of ['person@microsoft.com','person@contoso.com','person@'+A,'@demo.onmicrosoft.com','person@@demo.onmicrosoft.com','Name <person@demo.onmicrosoft.com>','person name@demo.onmicrosoft.com','.person@demo.onmicrosoft.com','person..one@demo.onmicrosoft.com','person.@demo.onmicrosoft.com','x'.repeat(65)+'@demo.onmicrosoft.com','person@demo.onmicrosoft.com.evil.example','person@demo.onmicrosoft.com/path','person@demo.onmicrosoft.com\nother'])assert.throws(()=>tenant(value),value);
});
test('email inputs persist only the domain and preserve immutable pairing rules',async t=>{
 const s=await fixture(t),p=await s.save(input('Email config','Person@DEMO.OnMicrosoft.com'));
 assert.equal(p.tenantInput,'demo.onmicrosoft.com');assert.equal(p.tenantId,null);assert.equal((await s.view(p,adapter)).microsoftVerified,false);
 const file=path.join(s.configDir,configFilename(p.name));assert.ok(!(await fs.readFile(file,'utf8')).includes('Person@'));
 const renamed=await s.save({...input('Renamed','another@demo.onmicrosoft.com'),id:p.id,expectedRevision:p.revision});assert.equal(renamed.tenantInput,p.tenantInput);
 await assert.rejects(s.save({...input('Renamed','other@different.onmicrosoft.com'),id:p.id,expectedRevision:renamed.revision}),e=>e.code==='pairing_immutable');
});
test('deleting a config removes its file, not credentials, runs or PDI binding',async t=>{
 const s=await fixture(t),p=await s.save(input()),other=await s.save(input('Keep',B,'https://dev456.service-now.com'));
 await s.select(p.id);await s.recordCheck(p,'admin',{status:'authenticated',checkedAt:new Date().toISOString()});
 const credential=path.join(s.runtimeHome,'credentials','fixture.txt');await fs.mkdir(path.dirname(credential),{recursive:true});await fs.writeFile(credential,'protected credential fixture');
 const runFile=path.join(s.runDir,'past-run','run.json');await atomic(runFile,{profileId:p.id,status:'complete'});
 const before=await s.registry();const outcome=await s.delete(p.id,p.revision);
 assert.equal(outcome.deletedProfileId,p.id);assert.equal(outcome.selectedProfileId,null);
 await assert.rejects(fs.access(path.join(s.configDir,configFilename(p.name))),e=>e.code==='ENOENT');assert.deepEqual((await s.list()).map(item=>item.id),[other.id]);
 assert.equal(await fs.readFile(credential,'utf8'),'protected credential fixture');assert.equal((await s.history())[0].profileId,p.id);
 const after=await s.registry();assert.deepEqual(after.bindings,before.bindings);assert.equal(after.checks[p.id],undefined);
 const newPair=await s.save(input('Other tenant',B));await assert.rejects(s.select(newPair.id),e=>e.code==='transition_required');
 const samePair=await s.save(input('Same tenant'));await s.select(samePair.id);assert.equal((await s.registry()).bindings[hostKey(p.pdiUrl)].profileId,samePair.id);
});
test('stale, invalid and unknown config deletion fails without clearing state',async t=>{
 const s=await fixture(t),p=await s.save(input());await s.select(p.id);const before=await s.registry();
 for(const revision of [undefined,0,-1,'1'])await assert.rejects(s.delete(p.id,revision));
 await assert.rejects(s.delete('../outside',p.revision));await assert.rejects(s.delete(p.id,2),e=>e.code==='stale_profile');
 assert.deepEqual(await s.registry(),before);assert.equal((await s.get(p.id)).revision,p.revision);
 await s.delete(p.id,p.revision);await assert.rejects(s.delete(p.id,p.revision),e=>e.code==='not_found');
});
test('deleting an unselected config leaves the selected config intact',async t=>{
 const s=await fixture(t),selected=await s.save(input()),other=await s.save(input('Delete me',B,'https://dev456.service-now.com'));
 await s.select(selected.id);await s.delete(other.id,other.revision);assert.equal((await s.registry()).selectedProfileId,selected.id);assert.equal((await s.get(selected.id)).name,selected.name);
});
test('atomic replace retries transient Windows sharing failures without deleting the destination',{skip:process.platform!=='win32'},async t=>{
 const s=await fixture(t),file=path.join(s.runtimeHome,'atomic-retry.json');await atomic(file,{value:'before'});
 const rename=fs.rename;let attempts=0;
 t.mock.method(fs,'rename',async(source,target)=>{if(target===file&&++attempts<3)throw Object.assign(new Error('sharing violation'),{code:'EPERM'});return rename(source,target);});
 await atomic(file,{value:'after'});assert.equal(attempts,3);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).value,'after');
});
test('atomic replace preserves existing data after persistent or unrelated errors',{skip:process.platform!=='win32'},async t=>{
 const s=await fixture(t),file=path.join(s.runtimeHome,'atomic-failure.json');await atomic(file,{value:'before'});
 const rename=fs.rename;let attempts=0,code='EPERM';
 t.mock.method(fs,'rename',async(source,target)=>{if(target!==file)return rename(source,target);attempts++;throw Object.assign(new Error('replace failed'),{code});});
 await assert.rejects(atomic(file,{value:'after'}),e=>e.code==='EPERM');assert.equal(attempts,5);
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).value,'before');assert.deepEqual(await fs.readdir(s.runtimeHome),['atomic-failure.json','state']);
 code='ENOSPC';attempts=0;await assert.rejects(atomic(file,{value:'after'}),e=>e.code==='ENOSPC');assert.equal(attempts,1);
});
test('config filenames are readable slugs and rename retains internal identity',async t=>{
 const s=await fixture(t),p=await s.save(input('COM to COM'));assert.equal(configFilename(p.name),'com-to-com-config.json');assert.equal(configFilename('com-to-com-config'),'com-to-com-config.json');assert.equal((await fs.readdir(s.configDir))[0],'com-to-com-config.json');
 const renamed=await s.save({...input('New name'),id:p.id,expectedRevision:p.revision});assert.equal(renamed.id,p.id);assert.deepEqual(await fs.readdir(s.configDir),['new-name-config.json']);assert.equal((await s.get(p.id)).name,'New name');
 await assert.rejects(s.save(input('New-name')),e=>e.code==='duplicate_name');assert.equal((await s.get(p.id)).revision,2);
 for(const name of ['...','///','***'])await assert.rejects(s.save(input(name)));assert.equal(configFilename('../../ outside'),'outside-config.json');
});
test('failed filename migration retains original file without duplicate records',async t=>{
 const s=await fixture(t),p=await s.save(input('Before'));
 const unlink=fs.unlink;t.mock.method(fs,'unlink',async file=>{if(file===path.join(s.configDir,'before-config.json'))throw Object.assign(new Error('locked'),{code:'EPERM'});return unlink(file);});
 await assert.rejects(s.save({...input('After'),id:p.id,expectedRevision:p.revision}),{code:'storage_error'});assert.deepEqual(await fs.readdir(s.configDir),['before-config.json']);assert.equal((await s.get(p.id)).name,'Before');
});
test('loading a config is explicit, nonsecret, nonactivating and does not import auth',async t=>{
 const s=await fixture(t),raw={...input('Imported'),schemaVersion:1,id:A,tenantId:A,people:[],microsoftVerified:true,authCacheKey:'a'.repeat(64)};
 await assert.rejects(s.loadProfile(raw,false));const loaded=await s.loadProfile(raw,true);assert.equal(loaded.profile.name,'Imported');assert.equal(loaded.profile.authCacheKey,null);assert.equal((await s.localInfo(loaded.profile)).microsoftVerified,false);assert.equal((await s.registry()).selectedProfileId,null);
 assert.deepEqual(await fs.readdir(s.configDir),['imported-config.json']);assert.equal((await s.loadProfile(raw,true)).loadedExisting,true);
 await assert.rejects(s.loadProfile({...raw,password:'secret fixture'},true),/Unexpected/);await assert.rejects(s.loadProfile({...raw,pdiUrl:'https://dev999.service-now.com'},true),{code:'import_conflict'});
 const person={userId:B,displayName:'Person',userPrincipalName:'person@demo.onmicrosoft.com',roleProfiles:['requester']};const other=await s.loadProfile({...raw,id:B,name:'People import',people:[person]},true);assert.equal(other.profile.people[0].tenantId,A);
});
test('manual Microsoft people are saved without sign-in and never create source records',async t=>{
 const s=await fixture(t),p=await s.save(input('Manual','demo.onmicrosoft.com'));
 const plan={displayName:'Alex Taylor',email:'Alex@demo.onmicrosoft.com',serviceNowUserName:'alex.taylor',accountIntent:'existing',roleProfiles:['requester']};
 const added=await s.saveManualPerson(p,plan);assert.equal(added.manualPeople.length,1);assert.equal(added.manualPeople[0].email,'alex@demo.onmicrosoft.com');assert.equal(added.manualPeople[0].accountIntent,'existing');assert.equal((await s.localInfo(added)).microsoftVerified,false);assert.equal(added.tenantId,null);
 const person=added.manualPeople[0];await assert.rejects(s.saveManualPerson(added,{...plan,displayName:'Duplicate'}),e=>e.code==='duplicate_person');
 await assert.rejects(s.saveManualPerson(added,{...plan,email:'different@demo.onmicrosoft.com'}),e=>e.code==='duplicate_person');
 const edited=await s.saveManualPerson(added,{...person,accountIntent:'create-if-missing',displayName:'Alex Revised'});assert.equal(edited.manualPeople.length,1);assert.equal(edited.manualPeople[0].id,person.id);assert.equal(edited.manualPeople[0].accountIntent,'create-if-missing');assert.equal(edited.manualPeople[0].serviceNowUserName,'alex.taylor');
 const raw=JSON.parse(await fs.readFile(path.join(s.configDir,configFilename(edited.name)),'utf8'));assert.equal(raw.manualPeople[0].displayName,'Alex Revised');
 const exported={...raw,name:'Manual imported'};delete exported.id;const loaded=await s.loadProfile(exported,true);assert.deepEqual(loaded.profile.manualPeople,raw.manualPeople);assert.equal((await s.localInfo(loaded.profile)).microsoftVerified,false);
 const removed=await s.removeManualPerson(edited,person.id);assert.equal(removed.manualPeople.length,0);assert.equal((await s.history()).length,0);
});
test('manual people reject wrong domain, duplicate IDs, unsafe identities, secrets and stale edits',async t=>{
 const s=await fixture(t),p=await s.save(input('Manual validation','demo.onmicrosoft.com'));
 const person={displayName:'Alex Taylor',email:'alex@demo.onmicrosoft.com',serviceNowUserName:'alex.taylor',accountIntent:'create-if-missing',roleProfiles:['requester']};
 for(const change of [{email:'alex@other.onmicrosoft.com'},{email:'Name <alex@demo.onmicrosoft.com>'},{serviceNowUserName:'alex^ORactive=true'},{serviceNowUserName:''},{serviceNowUserName:undefined},{accountIntent:'created'},{roleProfiles:['security_admin']},{roleProfiles:['admin','admin']},{roleProfiles:[]},{password:'never-save'},{serviceNowEmail:'different@demo.onmicrosoft.com'}])await assert.rejects(s.saveManualPerson(p,{...person,...change}));
 const added=await s.saveManualPerson(p,person);await assert.rejects(s.saveManualPerson(p,{...person,email:'new@demo.onmicrosoft.com'}),{code:'stale_profile'});
 assert.equal((await s.get(p.id)).manualPeople.length,1);assert.equal(added.manualPeople[0].serviceNowUserName,person.serviceNowUserName);assert.equal(added.manualPeople[0].email,person.email);
});
test('saved email-style ServiceNow logins survive edits and export/import unchanged',async t=>{
 const s=await fixture(t),p=await s.save(input('Legacy login','demo.onmicrosoft.com'));
 const added=await s.saveManualPerson(p,{displayName:'Alex Taylor',email:'alex@demo.onmicrosoft.com',serviceNowUserName:'Alex@demo.onmicrosoft.com',accountIntent:'existing',roleProfiles:['requester']});
 const edited=await s.saveManualPerson(added,{...added.manualPeople[0],displayName:'Alex Revised Taylor'});
 assert.equal(edited.manualPeople[0].serviceNowUserName,'Alex@demo.onmicrosoft.com');
 const raw=JSON.parse(await fs.readFile(path.join(s.configDir,configFilename(edited.name)),'utf8'));delete raw.id;raw.name='Imported legacy login';
 const loaded=await s.loadProfile(raw,true);assert.equal(loaded.profile.manualPeople[0].serviceNowUserName,'Alex@demo.onmicrosoft.com');assert.equal(loaded.profile.manualPeople[0].email,'alex@demo.onmicrosoft.com');
});
test('explicit Admin is a manual plan preserved through edits, reload and import',async t=>{
 const s=await fixture(t),p=await s.save(input('Admin planning','demo.onmicrosoft.com'));
 const added=await s.saveManualPerson(p,{displayName:'Alex Taylor',email:'alex@demo.onmicrosoft.com',serviceNowUserName:'alex.taylor',accountIntent:'create-if-missing',roleProfiles:['admin']});
 assert.deepEqual((await s.get(p.id)).manualPeople[0].roleProfiles,['admin']);
 const allRoles=['admin','requester','support','knowledge-author','knowledge-manager'];
 const edited=await s.saveManualPerson(added,{...added.manualPeople[0],displayName:'Alex Revised',roleProfiles:allRoles});
 assert.equal(edited.manualPeople[0].id,added.manualPeople[0].id);assert.deepEqual(edited.manualPeople[0].roleProfiles,allRoles);
 const raw=JSON.parse(await fs.readFile(path.join(s.configDir,configFilename(edited.name)),'utf8'));delete raw.id;raw.name='Imported Admin planning';
 const loaded=await s.loadProfile(raw,true);assert.deepEqual(loaded.profile.manualPeople[0].roleProfiles,allRoles);
 const reduced=await s.saveManualPerson(loaded.profile,{...loaded.profile.manualPeople[0],roleProfiles:['requester']});assert.deepEqual(reduced.manualPeople[0].roleProfiles,['requester']);
 const schema=JSON.parse(await fs.readFile(path.resolve(__dirname,'..','schemas','profile.schema.json'),'utf8')).properties.manualPeople.items.properties.roleProfiles;
 assert.equal(schema.maxItems,5);assert.deepEqual(new Set(schema.items.enum),new Set(allRoles));
 assert.equal((await s.registry()).selectedProfileId,null);assert.deepEqual(await s.history(),[]);
});
test('provisioning identity is explicit, imported and preserved; legacy configs retain admin',async t=>{
 const s=await fixture(t),p=await s.save(input('Bootstrap','demo.onmicrosoft.com'));assert.equal(p.bootstrapMode,'admin');
 const selected=await s.save({...input('Bootstrap','demo.onmicrosoft.com'),id:p.id,expectedRevision:p.revision,bootstrapMode:'machine'});assert.equal(selected.bootstrapMode,'machine');
 const edited=await s.save({...input('Bootstrap renamed','demo.onmicrosoft.com'),id:p.id,expectedRevision:selected.revision});assert.equal(edited.bootstrapMode,'machine');
 const raw=JSON.parse(await fs.readFile(path.join(s.configDir,configFilename(edited.name)),'utf8'));delete raw.id;raw.name='Imported Machine bootstrap';const loaded=await s.loadProfile(raw,true);assert.equal(loaded.profile.bootstrapMode,'machine');
 await assert.rejects(s.save({...input('Invalid','demo.onmicrosoft.com'),bootstrapMode:'guessed-fallback'}));
});
