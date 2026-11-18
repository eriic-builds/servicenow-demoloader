'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {ExecutionLocks,digest,frozen}=require('./execution.cjs');
const {setTimeout:delay}=require('node:timers/promises');
const {normalizePerson,validatePeople}=require('./manual-people.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES=new Set(['requester','support','knowledge-author','knowledge-manager']);
const clone=value=>JSON.parse(JSON.stringify(value));
const PROFILE_FILE=Symbol('profileFile');
function configFilename(name){
 const slug=text(name,'config name').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'');
 if(!slug||slug.length>120)throw error('Use a config name containing letters or numbers, up to 100 characters.');
 return (slug.endsWith('-config')?slug:slug+'-config')+'.json';
}
function error(message,code='invalid_input',status=400){return Object.assign(new Error(message),{code,status});}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))throw error('Expected a JSON object.');return value;}
function keys(value,allowed){object(value);for(const key of Object.keys(value))if(!allowed.includes(key))throw error(`Unexpected field: ${key}.`);}
function id(value){if(typeof value!=='string'||!UUID.test(value))throw error('Select a valid saved config identifier.');return value;}
function text(value,label,max=100){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw error(`Enter a valid ${label}.`);return value.trim();}
function pdi(value){text(value,'PDI URL',200);let url;try{url=new URL(value);}catch{throw error('Enter an HTTPS PDI origin.');}if(url.protocol!=='https:'||!/^dev[a-z0-9]+\.service-now\.com$/.test(url.hostname)||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'||/[\\\s]/.test(value))throw error('Use only your HTTPS dev*.service-now.com PDI origin, without a port, path, credentials or query.');return url.origin;}
function tenant(value){
 value=text(value,'CDX tenant or demo email',254).toLowerCase();
 const fromEmail=value.includes('@');
 if(fromEmail){
  const parts=value.split('@'),local=parts[0];
  if(parts.length!==2||!local||local.length>64||!/^[a-z0-9._%+-]+$/.test(local)||local.startsWith('.')||local.endsWith('.')||local.includes('..'))throw error('Enter one valid demo-user email, without a display name or spaces.');
  value=parts[1];
 }
 const domain=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onmicrosoft\.com$/;
 if((!UUID.test(value)&&!domain.test(value))||(fromEmail&&!domain.test(value)))throw error('Use a demo tenant GUID, onmicrosoft.com domain, or demo-user email ending in that domain. Custom-domain emails need the tenant GUID or onmicrosoft.com domain.');
 if(value==='72f988bf-86f1-41af-91ab-2d7cd011db47')throw error('The Microsoft corporate directory is not a CDX demo tenant.');
 return value;
}
function user(value){value=text(value,'ServiceNow User ID',120);if(/[:\s]/.test(value))throw error('User ID cannot contain whitespace or a colon.');return value;}
function integrationMode(value){if(value===undefined)return 'existing';if(!['create','existing'].includes(value))throw error('Choose create during onboarding or use an existing Machine account.');return value;}
function bootstrapMode(value){if(value===undefined)return 'admin';if(!['machine','admin'].includes(value))throw error('Choose the existing Machine or separately configured admin as the provisioning identity.');return value;}
function profileFields(input){
 const fields={name:text(input.name,'config name'),pdiUrl:pdi(input.pdiUrl),tenantInput:tenant(input.tenantInput),adminUser:user(input.adminUser),integrationUser:user(input.integrationUser),integrationMode:integrationMode(input.integrationMode),bootstrapMode:bootstrapMode(input.bootstrapMode)};
 if(fields.adminUser===fields.integrationUser)throw error('Admin and Machine identities must be separate User IDs.');
 return fields;
}
const hostKey=url=>createHash('sha256').update(new URL(pdi(url)).hostname).digest('hex');
const bindingKey=profile=>profile.tenantId||profile.tenantInput;
const fingerprint=profile=>createHash('sha256').update(JSON.stringify([profile.pdiUrl,profile.tenantInput,profile.adminUser,profile.integrationUser,integrationMode(profile.integrationMode)])).digest('hex');
async function readJson(file){let raw;try{raw=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw error('Local configuration storage could not be read.','storage_error',500);}if(Buffer.byteLength(raw)>2*1024*1024)throw error('Local configuration exceeds the supported size.','storage_error',500);try{return object(JSON.parse(raw));}catch(e){throw error('Local configuration is malformed; restore it rather than silently resetting state.','storage_error',500);}}
async function atomic(file,value,{newOnly=false}={}){
 await fs.mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
 try{
  const handle=await fs.open(temporary,'wx');
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n','utf8');await handle.sync();}finally{await handle.close();}
  if(newOnly){await fs.link(temporary,file);await fs.unlink(temporary);}
  else for(let attempt=0;;attempt++){
   try{await fs.rename(temporary,file);break;}
   catch(e){
    if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=4)throw e;
    // Windows scanners can briefly hold the destination; never delete it to replace it.
    await delay(40*2**attempt);
   }
  }
 }finally{await fs.rm(temporary,{force:true});}
}
function validatedProfile(raw){object(raw);if(raw.schemaVersion!==1)throw error('Unsupported saved-config schema.','storage_error',500);id(raw.id);text(raw.name,'config name');pdi(raw.pdiUrl);tenant(raw.tenantInput);user(raw.adminUser);user(raw.integrationUser);integrationMode(raw.integrationMode);bootstrapMode(raw.bootstrapMode);if(raw.attestedDemo!==true||!Number.isInteger(raw.revision)||raw.revision<1||!Array.isArray(raw.people))throw error('Saved config metadata is invalid.','storage_error',500);if(raw.tenantId!==null&&!UUID.test(raw.tenantId))throw error('Saved tenant identifier is invalid.','storage_error',500);keys(raw,['schemaVersion','id','name','revision','pdiUrl','tenantInput','tenantId','tenantDisplayName','authCacheKey','adminUser','integrationUser','integrationMode','bootstrapMode','attestedDemo','people','manualPeople','createdAt','updatedAt']);validatePeople(raw.manualPeople||[],raw.tenantInput);for(const person of raw.people){keys(person,['userId','displayName','userPrincipalName','mail','tenantId','roleProfiles']);id(person.userId);if(person.tenantId!==raw.tenantId||!Array.isArray(person.roleProfiles)||person.roleProfiles.some(role=>!ROLES.has(role)))throw error('Saved persona selection belongs to a different tenant.','storage_error',500);}return raw;}
class ProfileStore{
 constructor({outputRoot,runtimeHome}){if(!path.isAbsolute(outputRoot)||!path.isAbsolute(runtimeHome))throw error('Absolute build/output storage is required.');this.outputRoot=path.resolve(outputRoot);this.runtimeHome=path.resolve(runtimeHome);if(this.outputRoot===this.runtimeHome)throw error('Protected runtime cannot be the synced output folder.');this.configDir=path.join(this.outputRoot,'configs');this.runDir=path.join(this.outputRoot,'runs');this.registryFile=path.join(this.runtimeHome,'state','registry.json');this.lockFile=path.join(this.runtimeHome,'state','registry.lock');this.queue=Promise.resolve();this.executionLocks=new ExecutionLocks(this.runtimeHome);}
 async initialize(){await fs.mkdir(this.configDir,{recursive:true});await fs.mkdir(this.runDir,{recursive:true});await fs.mkdir(path.dirname(this.lockFile),{recursive:true});}
 async locked(work){const previous=this.queue;let release;this.queue=new Promise(resolve=>{release=resolve;});await previous;let lock;try{await this.initialize();try{lock=await fs.open(this.lockFile,'wx');}catch(e){if(e.code==='EEXIST')throw error('Another controller owns the config registry. If a previous process died, confirm it is stopped before removing its local lock.','controller_busy',409);throw error('The local execution lock could not be acquired.','storage_error',500);}const owner=require('./runtime-owner.cjs').currentProcess();await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),processStartedAt:owner.startedAt,executablePath:owner.executablePath}));let installing=true;try{await fs.access(path.join(this.runtimeHome,'state','installation.lock'));}catch(e){if(e.code!=='ENOENT')throw e;installing=false;}if(installing)throw error('Installation owns this local runtime. Wait for it to finish before changing configs or starting an operation.','installation_busy',409);return await work();}finally{if(lock){await lock.close();await fs.unlink(this.lockFile);}release();}}
 async registry(){const data=await readJson(this.registryFile);if(!data)return {schemaVersion:1,selectedProfileId:null,bindings:{},checks:{}};if(data.schemaVersion!==1||!data.bindings||!data.checks)throw error('Local execution registry is invalid.','storage_error',500);return data;}
  async list(){
   await this.initialize();const entries=await fs.readdir(this.configDir,{withFileTypes:true}),records=[],ids=new Set(),aliases=new Set(),filenames=new Set();
   for(const entry of entries){
    if(!entry.name.toLowerCase().endsWith('.json'))continue;
    if(!entry.isFile())throw error('A config entry is not a regular file. Review the library.','storage_error',500);
    const raw=validatedProfile(await readJson(path.join(this.configDir,entry.name)));
    if(entry.name.toLowerCase()!==raw.id+'.json'&&entry.name.toLowerCase()!==configFilename(raw.name))throw error('A saved config filename does not match its name or legacy ID. Review the library.','storage_error',500);
    const alias=raw.name.toLowerCase(),filename=configFilename(raw.name);
    if(ids.has(raw.id)||aliases.has(alias)||filenames.has(filename))throw error('Saved config names, filenames or IDs collide. Review the library before running.','ambiguous_profile',409);
    ids.add(raw.id);aliases.add(alias);filenames.add(filename);Object.defineProperty(raw,PROFILE_FILE,{value:entry.name});records.push(raw);
   }
   if(records.length>100)throw error('This prototype supports at most 100 named configurations.');
   return records.sort((a,b)=>a.name.localeCompare(b.name));
  }
  async get(profileId){id(profileId);const raw=(await this.list()).find(item=>item.id===profileId);if(!raw)throw error('Saved config not found.','not_found',404);return raw;}
  async writeProfile(profile,current){
   const filename=configFilename(profile.name),target=path.join(this.configDir,filename),previous=current?.[PROFILE_FILE];
   if(previous===filename)await atomic(target,profile);
   else{
    try{await atomic(target,profile,{newOnly:true});}catch(e){if(e.code==='EEXIST')throw error('A config with this filename already exists. Choose another name.','duplicate_name',409);throw e;}
    if(previous){
     try{await fs.unlink(path.join(this.configDir,previous));}
     catch(e){await fs.unlink(target);throw error('The original config file could not be renamed. It was kept unchanged; retry after resolving folder access.','storage_error',500);}
    }
   }
   Object.defineProperty(profile,PROFILE_FILE,{value:filename});return profile;
  }
 async resolve(nameOrId){if(UUID.test(nameOrId||''))return this.get(nameOrId);const name=text(nameOrId,'config name').toLowerCase();const matches=(await this.list()).filter(p=>p.name.toLowerCase()===name);if(matches.length!==1)throw error('That saved config name was not found.','not_found',404);return matches[0];}
 async localInfo(profile){const registry=await this.registry();const check=registry.checks[profile.id];const valid=check&&check.fingerprint===fingerprint(profile);return {microsoftVerified:Boolean(valid&&check.microsoft?.tenantId===profile.tenantId),pdiChecks:valid?check.pdiChecks||{admin:null,integration:null}:{admin:null,integration:null}};}
  async view(profile,adapter){return {...clone(profile),configFileName:profile[PROFILE_FILE]||configFilename(profile.name),...await this.localInfo(profile),credentials:await adapter.credentialStatus(profile)};}
   async state(adapter){const [profiles,registry]=await Promise.all([this.list(),this.registry()]);return {profiles:await Promise.all(profiles.map(p=>this.view(p,adapter))),selectedProfileId:registry.selectedProfileId,displayName:require('../release.json').displayName,skillName:require('../release.json').skillName,version:require('../release.json').version,storage:{outputRoot:this.outputRoot,configs:this.configDir,runs:this.runDir,runtimeHome:this.runtimeHome},capabilities:{contentCreation:typeof adapter.contentOperation==='function',knowledgePublication:typeof adapter.publishKnowledge==='function'&&typeof adapter.discoverPublication==='function',contentPreparation:typeof adapter.readBootstrap==='function',singlePersonRequest:true,personPasswords:typeof adapter.personPassword==='function',bootstrapActorChoice:true,profiles:true,profileImport:true,profileDeletion:true,credentialSetup:true,inlineCredentials:typeof adapter.saveCredential==='function',pdiReadCheck:true,microsoftDirectory:false,manualPeople:true,manualAdminRole:true,personProvisioning:typeof adapter.personOperation==='function'&&typeof adapter.readBootstrap==='function',onboardingDiscovery:typeof adapter.discoverOnboarding==='function',onboardingReuse:typeof adapter.discoverOnboarding==='function'&&typeof adapter.verifyMachine==='function',onboardingCreate:typeof adapter.machineOperation==='function',onboardingEnsure:true,isolatedAdminBrowser:adapter.isolatedAdminBrowser===true,seeding:false,provisioning:false}};}
  async save(input){keys(input,['id','expectedRevision','name','pdiUrl','tenantInput','adminUser','integrationUser','integrationMode','bootstrapMode','attestedDemo']);if(input.attestedDemo!==true)throw error('Confirm this is an owned demo PDI and CDX tenant, not production.');return this.locked(async()=>{const current=input.id?await this.get(input.id):null;await this.executionLocks.assertIdle(current?.pdiUrl||pdi(input.pdiUrl));if(current&&input.expectedRevision!==current.revision)throw error('Config changed elsewhere; reload before saving.','stale_profile',409);const fields={name:text(input.name,'config name'),pdiUrl:pdi(input.pdiUrl),tenantInput:tenant(input.tenantInput),adminUser:user(input.adminUser),integrationUser:user(input.integrationUser),integrationMode:integrationMode(input.integrationMode===undefined?current?.integrationMode:input.integrationMode),bootstrapMode:bootstrapMode(input.bootstrapMode===undefined?current?.bootstrapMode:input.bootstrapMode)};if(fields.adminUser===fields.integrationUser)throw error('Admin and Machine identities must be separate User IDs.');for(const other of await this.list())if(other.id!==current?.id&&other.name.toLowerCase()===fields.name.toLowerCase())throw error('A config with this name already exists.','duplicate_name',409);if(current&&(current.pdiUrl!==fields.pdiUrl||current.tenantInput!==fields.tenantInput))throw error('A saved pairing has immutable addresses. Create a new config for another PDI or tenant.','pairing_immutable',409);const now=new Date().toISOString();const profile={schemaVersion:1,id:current?.id||randomUUID(),revision:(current?.revision||0)+1,...fields,attestedDemo:true,tenantId:current?.tenantId||null,tenantDisplayName:current?.tenantDisplayName||null,authCacheKey:current?.authCacheKey||null,people:current?.people||[],manualPeople:current?.manualPeople||[],createdAt:current?.createdAt||now,updatedAt:now};return this.writeProfile(profile,current);});}
  async delete(profileId,expectedRevision){
   id(profileId);
   if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw error('Confirm the saved config revision before deleting.');
   return this.locked(async()=>{
    const current=await this.get(profileId);
    await this.executionLocks.assertIdle(current.pdiUrl);
    if(current.revision!==expectedRevision)throw error('Config changed since the deletion preview; reload and confirm again.','stale_profile',409);
    const registry=await this.registry();
    if(registry.selectedProfileId===current.id)registry.selectedProfileId=null;
    delete registry.checks[current.id];
    // Preserve the PDI binding: deleting a local config is not a tenant transition.
    await atomic(this.registryFile,registry);
    try{await fs.unlink(path.join(this.configDir,current[PROFILE_FILE]));}
    catch(e){if(!['EACCES','EPERM','ENOENT','EBUSY','EISDIR'].includes(e.code))throw e;throw error('Local selection/checks were cleared, but the config file could not be removed. Fix folder access and retry; PDI bindings, credentials and history are preserved.','storage_error',500);}
    return {deletedProfileId:current.id,name:current.name,selectedProfileId:registry.selectedProfileId};
   });
  }
  async loadProfile(input,confirmed){
   if(confirmed!==true)throw error('Review the config file and confirm loading before importing.','confirmation_required',409);
   keys(input,['version','schemaVersion','id','name','revision','pdiUrl','tenantInput','tenantId','tenantDisplayName','authCacheKey','adminUser','integrationUser','integrationMode','bootstrapMode','attestedDemo','microsoftVerified','people','manualPeople','createdAt','updatedAt']);
   if(input.schemaVersion!==undefined&&input.schemaVersion!==1)throw error('This config schema version is not supported.');
   if(input.id!==undefined)id(input.id);
   const fields=profileFields(input);
   if(input.attestedDemo!==true)throw error('The config must describe authorized demo environments.');
   const tenantId=input.tenantId==null?null:tenant(input.tenantId);
   if(tenantId&&!UUID.test(tenantId))throw error('The imported tenant ID must be a GUID.');
   if(UUID.test(fields.tenantInput)&&tenantId&&tenantId!==fields.tenantInput)throw error('The imported tenant GUID and saved directory ID disagree.');
   if(input.authCacheKey!=null&&(typeof input.authCacheKey!=='string'||!/^[0-9a-f]{64}$/.test(input.authCacheKey)))throw error('The imported authentication cache reference is invalid. No authentication is imported.');
   if(!Array.isArray(input.people)||input.people.length>100)throw error('The config must contain at most 100 planned people.');
   const seen=new Set();
   const people=input.people.map(person=>{
    keys(person,['userId','tenantId','displayName','userPrincipalName','mail','roleProfiles']);id(person.userId);
    if(!tenantId||(person.tenantId!==undefined&&person.tenantId!==tenantId)||seen.has(person.userId))throw error('Imported people must be unique and belong to this exact saved tenant.');
    seen.add(person.userId);
    const roles=person.roleProfiles;
    if(!Array.isArray(roles)||!roles.length||roles.length>4||roles.some(role=>!ROLES.has(role))||new Set(roles).size!==roles.length)throw error('The imported planned role profiles are invalid.');
    const displayName=typeof person.displayName==='string'&&!person.displayName?person.displayName:text(person.displayName,'person display name',1024);
    const userPrincipalName=text(person.userPrincipalName,'person principal name',1024);
    const mail=person.mail==null?null:text(person.mail,'person email',1024);
    return {userId:person.userId,tenantId,displayName,userPrincipalName,mail,roleProfiles:[...roles]};
   });
   return this.locked(async()=>{
    await this.executionLocks.assertIdle(fields.pdiUrl);
    const profiles=await this.list();
    const existing=profiles.find(profile=>profile.id===input.id)||profiles.find(profile=>profile.name.toLowerCase()===fields.name.toLowerCase());
    if(existing){
     if(existing.pdiUrl!==fields.pdiUrl||existing.tenantInput!==fields.tenantInput||existing.adminUser!==fields.adminUser||existing.integrationUser!==fields.integrationUser||integrationMode(existing.integrationMode)!==fields.integrationMode||(input.bootstrapMode!==undefined&&bootstrapMode(existing.bootstrapMode)!==fields.bootstrapMode)||(existing.tenantId&&tenantId&&existing.tenantId!==tenantId))throw error('This file conflicts with a saved config. No settings or passwords were overwritten. Use a different name or select the saved config.','import_conflict',409);
     return {profile:existing,loadedExisting:true};
    }
    if(profiles.length>=100)throw error('The config library is full.');
    const now=new Date().toISOString();
    const profile={schemaVersion:1,id:randomUUID(),revision:1,...fields,attestedDemo:true,tenantId,tenantDisplayName:null,authCacheKey:null,people,manualPeople:validatePeople(input.manualPeople||[],fields.tenantInput),createdAt:now,updatedAt:now};
    validatedProfile(profile);await this.writeProfile(profile);
    return {profile,loadedExisting:false};
   });
  }
  async mutate(profileId,revision,update,lease){return this.locked(async()=>{const current=await this.get(profileId);await this.executionLocks.assertIdle(current.pdiUrl,lease);if(current.revision!==revision)throw error('Config changed while the operation was running; reload it.','stale_profile',409);const next=await update(clone(current));next.revision++;next.updatedAt=new Date().toISOString();validatedProfile(next);return this.writeProfile(next,current);});}
  async saveManualPerson(profile,person){
   const planned=normalizePerson(person,profile.tenantInput);
   return this.mutate(profile.id,profile.revision,current=>{
    const people=current.manualPeople||[];
    if(person.id&&!people.some(item=>item.id===person.id))throw error('That saved person plan no longer exists. Reload before editing.','not_found',404);
    const next=[...people.filter(item=>item.id!==planned.id),planned];
    validatePeople(next,current.tenantInput);
    const legacy=current.people||[];
    if(legacy.some(item=>(item.userPrincipalName||item.mail||'').toLowerCase()===planned.email))throw error('This email is already in the saved directory selections. Review that existing entry instead of creating another plan.','duplicate_person',409);
    current.manualPeople=next;return current;
   });
  }
  async removeManualPerson(profile,personId){
   id(personId);return this.mutate(profile.id,profile.revision,current=>{
    if(!(current.manualPeople||[]).some(item=>item.id===personId))throw error('That person plan was not found.','not_found',404);
    current.manualPeople=current.manualPeople.filter(item=>item.id!==personId);return current;
   });
  }
 async invalidate(profile,purpose,lease){return this.locked(async()=>{const latest=await this.get(profile.id);await this.executionLocks.assertIdle(latest.pdiUrl,lease);if(latest.revision!==profile.revision)throw error('Config changed before connection setup.','stale_profile',409);const registry=await this.registry();let check=registry.checks[profile.id];if(!check||check.fingerprint!==fingerprint(profile))check={fingerprint:fingerprint(profile),pdiChecks:{admin:null,integration:null},microsoft:null};if(purpose==='microsoft')check.microsoft=null;else check.pdiChecks[purpose]=null;registry.checks[profile.id]=check;await atomic(this.registryFile,registry);});}
 async recordCheck(profile,purpose,value,lease){return this.locked(async()=>{const current=await this.get(profile.id);await this.executionLocks.assertIdle(current.pdiUrl,lease);if(current.revision!==profile.revision)throw error('Config changed during the check; result not bound to it.','stale_profile',409);const registry=await this.registry();let check=registry.checks[profile.id];if(!check||check.fingerprint!==fingerprint(current))check={fingerprint:fingerprint(current),pdiChecks:{admin:null,integration:null},microsoft:null};check.pdiChecks[purpose]=clone(value);registry.checks[profile.id]=check;await atomic(this.registryFile,registry);});}
 async verifyMicrosoft(profile,result,lease){id(result.tenantId);tenant(result.tenantId);if(UUID.test(profile.tenantInput)&&profile.tenantInput!==result.tenantId)throw error('Authenticated Microsoft tenant differs from requested GUID.','tenant_mismatch',409);const next=await this.mutate(profile.id,profile.revision,current=>{if(current.tenantId&&current.tenantId!==result.tenantId)throw error('Saved demo directory identity changed.','tenant_mismatch',409);return {...current,tenantId:result.tenantId,tenantDisplayName:text(result.tenantDisplayName||result.tenantId,'tenant display name',1024),authCacheKey:result.authCacheKey};},lease);await this.locked(async()=>{await this.executionLocks.assertIdle(next.pdiUrl,lease);const registry=await this.registry();let check=registry.checks[next.id];if(!check||check.fingerprint!==fingerprint(next))check={fingerprint:fingerprint(next),pdiChecks:{admin:null,integration:null}};check.microsoft={tenantId:next.tenantId,checkedAt:new Date().toISOString()};registry.checks[next.id]=check;const bound=registry.bindings[hostKey(next.pdiUrl)];if(bound?.profileId===next.id)bound.tenantKey=next.tenantId;await atomic(this.registryFile,registry);});return next;}
 async select(profileId){return this.locked(async()=>{const profile=await this.get(profileId);const registry=await this.registry();await this.executionLocks.assertIdle(profile.pdiUrl);if(registry.selectedProfileId){const selected=await this.get(registry.selectedProfileId);await this.executionLocks.assertIdle(selected.pdiUrl);}const key=hostKey(profile.pdiUrl);const bound=registry.bindings[key];if(bound&&bound.profileId!==profile.id&&bound.tenantKey!==bindingKey(profile))throw error('This PDI is bound to a different Microsoft tenant. An explicit transition is required; no users or content were remapped.','transition_required',409);registry.bindings[key]={profileId:profile.id,tenantKey:bindingKey(profile),state:'selected-not-write-verified',selectedAt:new Date().toISOString()};registry.selectedProfileId=profile.id;await atomic(this.registryFile,registry);return profile;});}
 async addPerson(profile,userRecord,roles){if(!(await this.localInfo(profile)).microsoftVerified)throw error('Verify the selected Microsoft demo tenant first.','directory_unverified',409);if(!Array.isArray(roles)||roles.length<1||roles.length>4||roles.some(r=>!ROLES.has(r)))throw error('Select a valid planned persona profile.');id(userRecord.id);if(userRecord.accountEnabled!==true)throw error('Disabled Microsoft accounts cannot be added to the active demo cast.');return this.mutate(profile.id,profile.revision,current=>{const person={userId:userRecord.id,tenantId:current.tenantId,displayName:userRecord.displayName,userPrincipalName:userRecord.userPrincipalName,mail:userRecord.mail,roleProfiles:[...new Set(roles)]};current.people=current.people.filter(p=>p.userId!==person.userId);if(current.people.length>=100)throw error('The prototype supports up to 100 planned people per config.');current.people.push(person);return current;});}
 async history(){await this.initialize();const entries=await fs.readdir(this.runDir,{withFileTypes:true});const runs=[];for(const e of entries){if(!e.isDirectory()||!/^[-a-zA-Z0-9_]{1,140}$/.test(e.name))continue;const manifest=await readJson(path.join(this.runDir,e.name,'run.json'));if(!manifest)continue;runs.push({runId:e.name,profileId:manifest.profileId||null,scenario:manifest.scenario||null,status:manifest.status||'unknown',createdAt:manifest.createdAt||null});}return runs.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,100);}
  async menu(adapter){const state=await this.state(adapter);const selected=state.profiles.find(p=>p.id===state.selectedProfileId)||null;return {ok:true,version:state.version,selectedProfile:selected,profileCount:state.profiles.length,readiness:{microsoft:'declared-only-no-sign-in',integration:selected?.pdiChecks?.integration?.status||'not-checked',seeding:'not-implemented'},menu:[{title:'Configure or select environment',description:'Open initial setup or choose a saved PDI/CDX config by name.'},{title:'Check saved setup',description:'Inspect saved credentials and readiness; external checks run only when requested.'},{title:'Load HR knowledge pack',description:'Preview a dedicated HR base, category, two Published articles and scoped access for one configured Knowledge person. Separate from the HTML config.'},{title:'Show past runs',description:'Read saved manifests without contacting either tenant.'}],knowledgePack:{id:'hr-essentials-v1',available:typeof adapter.knowledgePackOperation==='function',people:selected?require('./knowledge-pack.cjs').candidates(selected).map(person=>({id:person.id,displayName:person.displayName,serviceNowUserName:person.serviceNowUserName})):[],approvalRequired:true},contentNote:'Direct reviewed content plans can create an incident and/or new Knowledge article (Draft or Published). Checkout/revision, content updates, bulk re-seed and cleanup remain unavailable.',telemetry:'No app telemetry or credential/content uploads.'};}
  makeContext(profile,operation,payload,actor=null){if(!['incident.create','incident.update','knowledge.create','knowledge.update','knowledge.publish','onboarding.discover','onboarding.create','onboarding.reuse','people.provision','content.prepare','content.create','knowledge.pack'].includes(operation))throw error('Unsupported operation context.');return frozen({schemaVersion:1,profileId:profile.id,profileRevision:profile.revision,pdiUrl:profile.pdiUrl,tenantId:profile.tenantId,adminUser:profile.adminUser,integrationUser:profile.integrationUser,actor,operation,payloadSha256:digest(payload)});}
  async assertContext(context,payload){const profile=await this.get(context.profileId);const registry=await this.registry();if(digest(this.makeContext(profile,context.operation,payload,context.actor))!==digest(context))throw error('The approved operation context changed. Prepare a fresh preview.','stale_plan',409);if(!context.operation.startsWith('onboarding.')&&!['people.provision','content.prepare','content.create','knowledge.publish','knowledge.pack'].includes(context.operation)&&(!profile.tenantId||!(await this.localInfo(profile)).microsoftVerified))throw error('Microsoft tenant authentication is not verified for this legacy directory-bound operation.','not_ready',409);if(['content.create','knowledge.publish','knowledge.pack'].includes(context.operation)&&profile.bootstrapMode!=='machine')throw error('Content operations require the explicitly configured verified Machine path.','not_ready',409);if(registry.selectedProfileId!==profile.id||registry.bindings[hostKey(profile.pdiUrl)]?.profileId!==profile.id||registry.bindings[hostKey(profile.pdiUrl)]?.tenantKey!==bindingKey(profile))throw error('This profile is not the active pairing on its PDI.','wrong_pair',409);return profile;}
 async execute(context,payload,work){const approvedContext=frozen(context),approvedPayload=frozen(payload);let lease;const profile=await this.locked(async()=>{const current=await this.assertContext(approvedContext,approvedPayload);lease=await this.executionLocks.acquire(current.pdiUrl,approvedContext);return frozen(current);});try{return await work(profile,lease,approvedPayload,approvedContext);}finally{await this.executionLocks.release(lease);}}
 async executeLocal(profile,operation,work){let lease;const current=await this.locked(async()=>{const current=await this.get(profile.id);if(current.revision!==profile.revision)throw error('Config changed before the connection action.','stale_profile',409);lease=await this.executionLocks.acquire(current.pdiUrl,{profileId:current.id,profileRevision:current.revision,operation});return frozen(current);});try{return await work(current,lease);}finally{await this.executionLocks.release(lease);}}
}
module.exports={ProfileStore,error,pdi,tenant,hostKey,fingerprint,atomic,readJson,configFilename};
