'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {error,atomic,readJson}=require('./profiles.cjs');
const {digest,frozen}=require('./execution.cjs');
const {snapshot}=require('./onboarding.cjs');
const {normalizePerson}=require('./manual-people.cjs');
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SYSID=/^[0-9a-f]{32}$/;
const ROLE_NAMES={requester:null,support:'itil','knowledge-author':'knowledge','knowledge-manager':'knowledge_admin',admin:'admin'};
const bool=value=>value===true||value==='true';
const lower=value=>typeof value==='string'?value.trim().toLowerCase():'';
const now=()=>new Date().toISOString();
function rows(value,label){if(value?.outcome!=='readable'||value.truncated||!Array.isArray(value.rows))throw error(label+' is denied, truncated or unknown. Nothing is assumed missing.','people_lookup_unknown',409);return value.rows;}
function compatible(row,person,human){return SYSID.test(row?.sys_id||'')&&lower(row.user_name)===lower(person.serviceNowUserName)&&lower(row.email)===person.email&&bool(row.active)&&[false,'false'].includes(row.web_service_access_only)&&row.identity_type===human;}
function owned(row,operation){const fields=operation.fields;return compatible(row,{serviceNowUserName:fields.user_name,email:fields.email},fields.identity_type)&&row.sys_id===fields.sys_id&&row.source===fields.source&&row.user_name===fields.user_name&&row.first_name===fields.first_name&&row.last_name===fields.last_name;}
function operationId(planId,personId){const hex=digest([planId,personId]).slice(0,32);return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}
class PeopleProvisioning{
 constructor({store,adapter}){this.store=store;this.adapter=adapter;this.directory=path.join(store.runtimeHome,'state','people-provisioning');}
 file(id){if(!UUID.test(id||''))throw error('Select a valid people preview.');return path.join(this.directory,id+'.json');}
 async load(id){const state=await readJson(this.file(id));if(!state)throw error('People preview not found.','not_found',404);if(state.plan?.id!==id||digest(state.plan)!==state.planHash||!['preview','blocked','approved','attempting','partial','uncertain','confirmed','failed'].includes(state.status))throw error('Stored people approval is corrupt.','plan_corrupt',409);return state;}
 async persist(state){state.updatedAt=now();await atomic(this.file(state.plan.id),state);await atomic(path.join(this.directory,'latest-'+state.plan.context.profileId+'.json'),{planId:state.plan.id});await atomic(path.join(this.store.runDir,state.plan.id,'run.json'),{schemaVersion:1,runId:state.plan.id,profileId:state.plan.context.profileId,scenario:'people.provision',createdAt:state.plan.createdAt,updatedAt:state.updatedAt,status:state.status,context:state.plan.context,planHash:state.planHash,sourceWrites:state.sourceWrites,mappings:state.mappings,steps:state.steps});return frozen(state);}
 async assertNoUnresolved(profile){let files;try{files=await fs.readdir(this.directory);}catch(e){if(e.code==='ENOENT')return;throw e;}for(const name of files.filter(name=>name.endsWith('.json')&&UUID.test(name.slice(0,-5)))){const state=await this.load(name.slice(0,-5));if(state.plan.context.pdiUrl===profile.pdiUrl&&state.sourceWrites&&state.status!=='confirmed')throw error('An earlier people write on this PDI needs reconciliation; a new preview cannot bypass it.','reconciliation_required',409);}}
 async inspect(profile,id,allowOwned=[],{signal}={}){
  const payload={actor:null,authority:null,operations:[],blockers:[],notificationConsequences:'Normal ServiceNow audit, business rules and notifications may run. No passwords, Microsoft accounts, connectors or existing users are changed.'},observations=new Map();
  const block=(code,message)=>payload.blockers.push({code,message});
  if(profile.bootstrapMode!=='machine'||typeof this.adapter.readBootstrap!=='function'||typeof this.adapter.personOperation!=='function'){block('machine_bootstrap_required','Select an already-created API Machine as the provisioning identity. Human provisioning never falls back to another credential.');return {payload,observations};}
  const people=profile.manualPeople||[];if(!people.length){block('people_missing','Add the demo people to this saved config first.');return {payload,observations};}
  const roleNames=[...new Set(people.flatMap(person=>person.roleProfiles.map(role=>ROLE_NAMES[role]).filter(Boolean)))];
  const data=await this.adapter.discoverOnboarding(profile,roleNames,{signal}),bootstrap=snapshot(profile,[],data);
  if(bootstrap.blockers.length){payload.blockers.push(...bootstrap.blockers);return {payload,observations};}
  payload.actor=bootstrap.actor;
  try{
   const dictionary=rows(await this.adapter.readBootstrap(profile,'peopleDictionary',{}, {signal}),'Human-user schema');
   const required=['user_name','email','first_name','last_name','active','identity_type','web_service_access_only','source'];
   const fields=required.map(name=>{const matches=dictionary.filter(row=>row.name==='sys_user'&&row.element===name);if(matches.length!==1||!SYSID.test(matches[0].sys_id||''))throw error('Human field '+name+' is not uniquely readable.','people_schema_invalid',409);const row=matches[0];return {name,sysId:row.sys_id,type:row.internal_type,readOnly:row.read_only,unique:row.unique,maxLength:/^\d+$/.test(String(row.max_length))?Number(row.max_length):null};});
   const humans=rows(data.choices,'Identity choices').filter(row=>row.name==='sys_user'&&row.element==='identity_type'&&row.label==='Human'&&row.language==='en'&&[false,'false'].includes(row.inactive));if(humans.length!==1||typeof humans[0].value!=='string'||!humans[0].value)throw error('A unique installed Human choice is required.','people_schema_invalid',409);
   const installed=rows(data.roles,'Installed roles'),roles=roleNames.map(name=>{const matches=installed.filter(role=>role.name===name);if(matches.length!==1||!SYSID.test(matches[0].sys_id||''))throw error('Role '+name+' is not uniquely installed.','people_role_missing',409);return {name,sysId:matches[0].sys_id};}).sort((a,b)=>a.name.localeCompare(b.name));
   payload.authority={bootstrap,humanChoice:humans[0].value,fields,roles};
   for(const person of people){
    const matches=rows(await this.adapter.readBootstrap(profile,'person',{targetUser:person.serviceNowUserName,email:person.email},{signal}),'Email/login lookup for '+person.displayName);
    const requiredRoles=roles.filter(role=>person.roleProfiles.some(name=>ROLE_NAMES[name]===role.name));
    const opId=operationId(id,person.id),parts=person.displayName.trim().split(/\s+/),proposed={sys_id:opId.replaceAll('-',''),user_name:person.serviceNowUserName,email:person.email,first_name:parts.slice(0,-1).join(' '),last_name:parts.at(-1),active:true,identity_type:humans[0].value,web_service_access_only:false,source:'SN-DemoSeeder:'+opId};
    const operation={personId:person.id,displayName:person.displayName,operationId:opId,kind:'create',fields:proposed,roles:requiredRoles};
    const prior=allowOwned.find(item=>item.personId===person.id);
    if(matches.length>1){block('people_collision',person.displayName+': email/login resolve to multiple accounts. No duplicate or repair is created.');continue;}
    let grants=[];
    if(matches.length===1){
     const row=matches[0];if(!compatible(row,person,humans[0].value)){block('people_mismatch',person.displayName+': login/email, active status or Human identity do not match. No silent correction.');continue;}
     grants=rows(await this.adapter.readBootstrap(profile,'grants',{recordId:row.sys_id},{signal}),'Role assignments for '+person.displayName);
     if(grants.some(grant=>grant.user!==row.sys_id||!SYSID.test(grant.sys_id||'')||!SYSID.test(grant.role||'')))throw error('Role lookup returned inconsistent identities.','people_lookup_unknown',409);
     if(prior&&owned(row,prior)){
      if(!prior.roles.some(role=>role.name==='admin')&&grants.some(grant=>installed.some(role=>role.name==='admin'&&role.sys_id===grant.role))){block('unexpected_admin',person.displayName+': an unapproved admin grant appeared on the created account.');continue;}
     }else{
      if(requiredRoles.some(role=>!grants.some(grant=>grant.role===role.sysId))){block('borrowed_roles_missing',person.displayName+': an existing account lacks a planned role. Reuse never grants or resets borrowed accounts.');continue;}
      operation.kind='reuse';operation.sourceId=row.sys_id;delete operation.fields;
     }
    }else if(person.accountIntent==='existing'){block('existing_person_missing',person.displayName+': declared existing, but no exact email/login match was found.');continue;}
    if(operation.kind==='create'){
     if(parts.length<2||!proposed.first_name){block('person_name_required',person.displayName+': a first and last name must be reviewed before creation.');continue;}
     const types={user_name:['string'],email:['email','string'],first_name:['string'],last_name:['string'],active:['boolean'],identity_type:['choice','string','integer'],web_service_access_only:['boolean'],source:['string']};
     if(fields.some(field=>![false,'false'].includes(field.readOnly)||!types[field.name].includes(field.type)||(typeof proposed[field.name]==='string'&&(!Number.isInteger(field.maxLength)||field.maxLength<proposed[field.name].length)))||!bool(fields.find(field=>field.name==='user_name').unique)){block('people_creation_schema',person.displayName+': writable supported fields, lengths and source-enforced unique login must be proven.');continue;}
    }
    observations.set(person.id,{row:matches[0]||null,grants});payload.operations.push(operation);
   }
  }catch(e){if(!e.status)throw e;block(e.code,e.message);}
  return {payload,observations};
 }
 async preview(profileId,revision,{signal,requestedPeople=null}={}){const profile=await this.store.get(profileId);if(profile.revision!==revision)throw error('Config changed before people preview.','stale_profile',409);const input={manualPeople:requestedPeople||profile.manualPeople||[]};return this.store.execute(this.store.makeContext(profile,'people.provision',input),input,async current=>{await this.assertNoUnresolved(current);const id=randomUUID(),{payload}=await this.inspect({...current,manualPeople:input.manualPeople},id,[],{signal}),plan=frozen({schemaVersion:1,id,createdAt:now(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),context:this.store.makeContext(current,'people.provision',payload,payload.actor),...(requestedPeople?{requestedPeople,scope:'explicit-ServiceNow-account-request-no-Microsoft-tenant-membership-claim'}:{}),payload});return this.persist({plan,planHash:digest(plan),status:payload.blockers.length?'blocked':'preview',approval:null,steps:[],mappings:[],sourceWrites:false});});}
 async previewPerson(profileId,revision,person,{signal,confirmedExternalEmail=false}={}){
  if(!person||person.id!==undefined)throw error('An explicit new source-account request must not reuse a saved person-plan ID.');
  const profile=await this.store.get(profileId),requested=normalizePerson(person,profile.tenantInput,{requireTenantDomain:!confirmedExternalEmail});
  return this.preview(profileId,revision,{signal,requestedPeople:[requested]});
 }
 async approve(id,hash,confirmed){if(confirmed!==true)throw error('Review the exact people changes before approval.','approval_required',409);const saved=await this.load(id);return this.store.execute(saved.plan.context,saved.plan.payload,async()=>{const state=await this.load(id),resume=state.status==='partial'&&!state.steps.some(step=>['attempting','uncertain'].includes(step.status));if(state.planHash!==hash||state.plan.payload.blockers.length||(!resume&&state.status!=='preview')||Date.parse(state.plan.expiresAt)<=Date.now())throw error('People approval is stale, blocked or requires reconciliation.','stale_plan',409);state.approval={planHash:hash,approvedAt:now()};state.status='approved';return this.persist(state);});}
 async apply(id,hash,{signal,reconcile=false,password}={}){
  const saved=await this.load(id);
  if(saved.plan.kind==='passwords')return this.applyPasswords(saved,hash,{signal,reconcile,password});
  return this.store.execute(saved.plan.context,saved.plan.payload,async profile=>{
   const state=await this.load(id),plan=state.plan;
   if(hash!==state.planHash||state.approval?.planHash!==hash||plan.payload.blockers.length)throw error('Exact approved people changes are required.','approval_required',409);
   if(state.status==='confirmed')return frozen(state);
   if((!reconcile&&state.status!=='approved')||(reconcile&&!['attempting','partial','uncertain'].includes(state.status)))throw error('Reconcile this attempt instead of repeating it.','reconciliation_required',409);
   if(!reconcile&&Date.parse(plan.expiresAt)<=Date.now())throw error('People approval expired.','stale_plan',409);
   const fresh=async()=>{const allowOwned=plan.payload.operations.filter(op=>op.kind==='create'&&state.steps.some(step=>step.name===op.personId+':create'&&['attempting','uncertain','confirmed'].includes(step.status)));const result=await this.inspect(plan.requestedPeople?{...profile,manualPeople:plan.requestedPeople}:profile,id,allowOwned,{signal});if(result.payload.blockers.length||digest(result.payload)!==digest(plan.payload))throw error('Actor, schema, role or person state changed from the approved plan. No collided user is adopted.','stale_plan',409);return result.observations;};
   const write=async(operation,role)=>{
    const name=operation.personId+(role?':role:'+role.sysId:':create'),existing=state.steps.find(step=>step.name===name);
    if(existing?.status==='confirmed')return true;if(existing&&['attempting','uncertain'].includes(existing.status))throw error('An uncertain people write cannot be repeated.','reconciliation_required',409);
    const step=existing||{name,personId:operation.personId,roleId:role?.sysId||null};if(!existing)state.steps.push(step);step.status='attempting';state.status='attempting';state.sourceWrites=true;await this.persist(state);
    const grantId=role?digest([id,operation.personId,role.sysId]).slice(0,32):undefined;
    const result=await this.adapter.personOperation(profile,role?'CreatePersonRole':'CreatePerson',plan.payload.actor,operation,plan.payload.authority.bootstrap.schema.machineChoice.value,{signal,role,grantId});
    const match=role?result.row?.sys_id===grantId&&result.row.user===operation.fields.sys_id&&result.row.role===role.sysId:owned(result.row,operation);
    if(result.outcome!=='created'||!match){step.status=result.outcome==='rejected'?'rejected':'uncertain';state.status=step.status==='uncertain'?'uncertain':'partial';await this.persist(state);return false;}
    step.status='confirmed';step.sysId=result.row.sys_id;await this.persist(state);return true;
   };
   try{
    let observations=await fresh();
    if(reconcile){
     for(const op of plan.payload.operations.filter(op=>op.kind==='create')){const observation=observations.get(op.personId);for(const step of state.steps.filter(step=>step.personId===op.personId&&['attempting','uncertain'].includes(step.status))){if(owned(observation.row,op)&&(!step.roleId||observation.grants.some(grant=>grant.sys_id===digest([id,op.personId,step.roleId]).slice(0,32)&&grant.role===step.roleId))){step.status='confirmed';step.sysId=step.roleId?digest([id,op.personId,step.roleId]).slice(0,32):op.fields.sys_id;}}}
     state.status=state.steps.some(step=>['attempting','uncertain'].includes(step.status))?'uncertain':'partial';return this.persist(state);
    }
    for(const operation of plan.payload.operations){
     if(operation.kind==='reuse'){state.mappings=state.mappings.filter(item=>item.personId!==operation.personId);state.mappings.push({personId:operation.personId,sysId:operation.sourceId,ownership:'borrowed-unchanged'});await this.persist(state);continue;}
     observations=await fresh();let observation=observations.get(operation.personId),creation=state.steps.find(step=>step.name===operation.personId+':create');
     if(creation?.status!=='confirmed'){if(observation.row)throw error('An account appeared before creation.','people_collision',409);if(!await write(operation))return frozen(state);observations=await fresh();observation=observations.get(operation.personId);}
     if(!owned(observation.row,operation))throw error('Created person read-back does not match the owned ID, email and fields.','ownership_mismatch',409);
     for(const role of operation.roles){observations=await fresh();observation=observations.get(operation.personId);const matches=observation.grants.filter(grant=>grant.role===role.sysId);if(matches.length>1)throw error('Ambiguous existing grants; no duplicate is created.','people_collision',409);if(matches.length===1)continue;if(!await write(operation,role))return frozen(state);}
     state.mappings=state.mappings.filter(item=>item.personId!==operation.personId);state.mappings.push({personId:operation.personId,sysId:operation.fields.sys_id,email:operation.fields.email,ownership:'created-by-this-operation',source:operation.fields.source});await this.persist(state);
    }
    const final=await fresh();for(const op of plan.payload.operations){const observation=final.get(op.personId);if(!observation.row||op.roles.some(role=>!observation.grants.some(grant=>grant.role===role.sysId)))throw error('Final email/identity/role read-back did not match.','people_verification_failed',409);}
    state.status='confirmed';return this.persist(state);
   }catch(e){for(const step of state.steps)if(step.status==='attempting')step.status='uncertain';state.status=state.steps.some(step=>step.status==='uncertain')?'uncertain':state.sourceWrites?'partial':'failed';state.failureCode=e.code||'people_internal_error';await this.persist(state);throw error('People provisioning stopped ('+state.failureCode+'). Inspect/reconcile the existing journal; never create a substitute.',state.failureCode,e.status||500);}
  });
 }
 async inspectPasswords(profile,requestedTargets,{signal}={}){
  if(profile.bootstrapMode!=='machine'||typeof this.adapter.personPassword!=='function')throw error('Password changes require the verified configured Machine adapter.','password_path_unavailable',409);
  const data=await this.adapter.discoverOnboarding(profile,[],{signal}),bootstrap=snapshot(profile,[],data);
  if(bootstrap.blockers.length)throw error('Machine identity and existing admin access must be verified before password changes.','password_actor_unverified',409);
  const choices=rows(data.choices,'Identity choices').filter(row=>row.label==='Human'&&row.language==='en'&&[false,'false'].includes(row.inactive));
  if(choices.length!==1)throw error('The installed Human choice is not unique.','people_schema_invalid',409);
  const dictionary=rows(await this.adapter.readBootstrap(profile,'passwordDictionary',{}, {signal}),'Password field metadata');
  const fields=['user_password','password_needs_reset'].map(name=>{const matches=dictionary.filter(row=>row.name==='sys_user'&&row.element===name);if(matches.length!==1||![false,'false'].includes(matches[0].read_only)||!SYSID.test(matches[0].sys_id||''))throw error('Password fields must be readable and writable.','password_schema_invalid',409);return {name,sysId:matches[0].sys_id,type:matches[0].internal_type,maxLength:/^\d+$/.test(String(matches[0].max_length))?Number(matches[0].max_length):null};});
  if(!['password','password2'].includes(fields[0].type)||!Number.isInteger(fields[0].maxLength)||fields[0].maxLength<1||fields[1].type!=='boolean')throw error('Unsupported password field metadata.','password_schema_invalid',409);
  const targets=[];
  for(const person of requestedTargets){const matches=rows(await this.adapter.readBootstrap(profile,'person',{targetUser:person.serviceNowUserName,email:person.email},{signal}),'Exact password target');if(matches.length!==1||!compatible(matches[0],person,choices[0].value)||matches[0].sys_id===bootstrap.actor.sysId)throw error('Password target must resolve to one exact active Human account with the supplied email/login, never the Machine actor.','password_target_mismatch',409);const row=matches[0];targets.push({displayName:person.displayName,sysId:row.sys_id,userName:row.user_name,email:lower(row.email),identityType:row.identity_type,source:row.source||''});}
  return {action:'set-explicit-ServiceNow-passwords',actor:bootstrap.actor,bootstrap,fields,targets,blockers:[],passwordHandling:'Supplied once in authenticated request/stdin. Not saved in configs, journals, exports or logs. No password is copied to Microsoft.',notificationConsequences:'Existing ServiceNow passwords are replaced; normal source audit, policies and notifications may run. No roles are changed. password_needs_reset is set false for these demo accounts.'};
 }
 async previewPasswords(profileId,revision,targets,{signal}={}){
  if(!Array.isArray(targets)||targets.length<1||targets.length>10)throw error('Choose one to ten exact Human password targets.');
  const profile=await this.store.get(profileId);if(profile.revision!==revision)throw error('Config changed before the password preview.','stale_profile',409);
  const requestedTargets=targets.map(target=>{if(!target||Object.keys(target).some(key=>!['displayName','email','serviceNowUserName'].includes(key)))throw error('Password preview accepts identity fields only; do not include a password.');return normalizePerson({...target,accountIntent:'existing',roleProfiles:['requester']},profile.tenantInput,{requireTenantDomain:false});});
  if(new Set(requestedTargets.map(target=>target.email)).size!==requestedTargets.length||new Set(requestedTargets.map(target=>lower(target.serviceNowUserName))).size!==requestedTargets.length)throw error('Password targets must be unique.');
  const input={requestedTargets};return this.store.execute(this.store.makeContext(profile,'people.provision',input),input,async current=>{await this.assertNoUnresolved(current);const payload=await this.inspectPasswords(current,requestedTargets,{signal}),plan=frozen({schemaVersion:1,id:randomUUID(),kind:'passwords',createdAt:now(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),context:this.store.makeContext(current,'people.provision',payload,payload.actor),requestedTargets,payload});return this.persist({plan,planHash:digest(plan),status:'preview',approval:null,steps:[],mappings:[],sourceWrites:false});});
 }
 async applyPasswords(saved,hash,{signal,password,reconcile=false}={}){
  if(typeof password!=='string'||!password.length||password.length>4096||password.includes('\0'))throw error('Enter a nonempty bounded password through the protected request.');
  try{return await this.store.execute(saved.plan.context,saved.plan.payload,async profile=>{
   const state=await this.load(saved.plan.id),plan=state.plan;
   if(hash!==state.planHash||state.approval?.planHash!==hash||plan.kind!=='passwords')throw error('Exact approved password targets are required.','approval_required',409);
   if(state.status==='confirmed')return frozen(state);
   if((!reconcile&&state.status!=='approved')||(reconcile&&!['partial','uncertain','attempting'].includes(state.status)))throw error('An uncertain password update may only be verified, not blindly repeated.','reconciliation_required',409);
   if(!reconcile&&Date.parse(plan.expiresAt)<=Date.now())throw error('Password approval expired.','stale_plan',409);
   if(password.length>plan.payload.fields.find(field=>field.name==='user_password').maxLength)throw error('The password exceeds the installed field limit.');
   const refreshed=await this.inspectPasswords(profile,plan.requestedTargets,{signal});if(digest(refreshed)!==digest(plan.payload))throw error('The approved actor, targets or password metadata changed.','stale_plan',409);
   try{
    for(const target of plan.payload.targets){let step=state.steps.find(item=>item.sysId===target.sysId);if(step?.status==='confirmed')continue;
     if(reconcile&&!step)continue;if(!reconcile&&step&&['attempting','uncertain'].includes(step.status))throw error('A prior password attempt must be verified without resetting it.','reconciliation_required',409);
     if(!step){step={name:'password-update',sysId:target.sysId,userName:target.userName};state.steps.push(step);}step.status='attempting';state.status='attempting';if(!reconcile)state.sourceWrites=true;await this.persist(state);
     const result=await this.adapter.personPassword(profile,plan.payload.actor,target,plan.payload.bootstrap.schema.machineChoice.value,password,{signal,verifyOnly:reconcile});
     step.authentication=result.authentication||'not-verified';step.updateAccepted=result.updateAccepted===true||step.updateAccepted===true;
     if(result.outcome==='verified'||(result.outcome==='applied'&&result.updateAccepted===true)){step.status='confirmed';}else{step.status=result.outcome==='rejected'?'rejected':'uncertain';state.status=step.status==='uncertain'?'uncertain':'partial';await this.persist(state);return frozen(state);}await this.persist(state);
    }
    state.status=state.steps.length===plan.payload.targets.length&&state.steps.every(step=>step.status==='confirmed')?'confirmed':'partial';return this.persist(state);
   }catch(e){for(const step of state.steps)if(step.status==='attempting')step.status='uncertain';state.status=state.steps.some(step=>step.status==='uncertain')?'uncertain':state.sourceWrites?'partial':'failed';state.failureCode=['stale_plan','password_target_mismatch','reconciliation_required'].includes(e.code)?e.code:'password_operation_failed';await this.persist(state);throw error('Password operation stopped. Inspect the sanitized journal and verify uncertain outcomes before another reset.',state.failureCode,409);}
  });}finally{password=null;}
 }
 async status(id){return frozen(await this.load(id));}
 async statusForProfile(profileId){await this.store.get(profileId);const latest=await readJson(path.join(this.directory,'latest-'+profileId+'.json'));return latest?this.status(latest.planId):null;}
}
module.exports={PeopleProvisioning,compatible,owned,operationId};
