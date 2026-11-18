'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {error,atomic,readJson}=require('./profiles.cjs');
const {digest,frozen}=require('./execution.cjs');
const {PeopleProvisioning,operationId}=require('./people.cjs');
const UUID=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SYSID=/^[0-9a-f]{32}$/;
const bool=value=>value===true||value==='true';
const now=()=>new Date().toISOString();
function fail(message,code='content_invalid'){return error(message,code,409);}
function object(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('Enter only supported content fields.');}
function text(value,max){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw fail('Content text is empty, oversized or contains control characters.');return value;}
function visible(value){if(/\b(demo|synthetic|fictional|fake|sample[ -]?data|test[ -]?data)\b/i.test(value))throw fail('Audience-visible text must not contain artificial-data labels.','content_realism');return value;}
function sysid(value){if(!SYSID.test(value||''))throw fail('A content reference must be an exact source ID.');return value;}
function rows(value,label){if(value?.outcome!=='readable'||value.truncated||!Array.isArray(value.rows))throw fail(label+' is denied, truncated or unknown.','content_lookup_unknown');return value.rows;}
function normalizeHtml(value){return String(value).replace(/\r\n/g,'\n').replace(/<br\s*\/?>/gi,'<br>').replace(/>\s+</g,'><').trim();}
function inputValue(value){
 object(value,['businessKey','incident','knowledge']);
 if(typeof value.businessKey!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(value.businessKey)||(!value.incident&&!value.knowledge))throw fail('Choose a stable content-run key and at least one record.');
 const input={businessKey:value.businessKey};
 if(value.incident){object(value.incident,['short_description','description','caller_id','category','impact','urgency']);const v=value.incident;input.incident={short_description:visible(text(v.short_description,160)),description:visible(text(v.description,4000)),caller_id:sysid(v.caller_id)};for(const key of ['category','impact','urgency'])if(v[key]!==undefined)input.incident[key]=text(v[key],80);}
 if(value.knowledge){
  object(value.knowledge,['short_description','text','author','kb_knowledge_base','publish']);
  const v=value.knowledge,body=visible(text(v.text,65000)),publish=v.publish===undefined?true:v.publish;
  if(typeof publish!=='boolean')throw fail('Knowledge publish must be true or false.');
  if(/<(?!\/?(?:h[1-6]|p|ul|ol|li|strong|em|br|blockquote|code|pre)\s*\/?>)/i.test(body)||/javascript:/i.test(body))throw fail('Knowledge HTML must use simple safe structural tags without attributes.');
  input.knowledge={short_description:visible(text(v.short_description,100)),text:body,author:sysid(v.author),kb_knowledge_base:sysid(v.kb_knowledge_base),publish};
 }
 for(const item of [input.incident,input.knowledge].filter(Boolean))if(/[\^\r\n]/.test(item.short_description))throw fail('A content title cannot contain encoded-query separators or newlines.');
 return frozen(input);
}
function ordered(values){return [...values].sort((a,b)=>digest(a).localeCompare(digest(b)));}
function owns(row,operation,actor){
 if(!row||row.sys_id!==operation.fields.sys_id||row.sys_created_by!==actor.userName||typeof row.number!=='string'||!row.number)return false;
 for(const [key,value]of Object.entries(operation.fields)){
  if(key==='text'){if(normalizeHtml(row[key])!==normalizeHtml(value))return false;}
  else if(typeof value==='boolean'){if(![true,false,'true','false'].includes(row[key])||bool(row[key])!==value)return false;}
  else if(row[key]!==value)return false;
 }
 return true;
}
class ContentProvisioning{
 constructor({store,adapter}){this.store=store;this.adapter=adapter;this.people=new PeopleProvisioning({store,adapter});this.directory=path.join(store.runtimeHome,'state','content-provisioning');}
 file(id){if(!UUID.test(id||''))throw fail('Select a valid content plan ID.');return path.join(this.directory,id+'.json');}
 async load(id){const state=await readJson(this.file(id));if(!state)throw error('Content plan not found.','not_found',404);if(state.plan?.id!==id||digest(state.plan)!==state.planHash||!['preview','blocked','approved','attempting','partial','uncertain','confirmed','failed'].includes(state.status))throw fail('Stored content authority is corrupt.','plan_corrupt');return state;}
 async states(){let names;try{names=await fs.readdir(this.directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}const states=[];for(const name of names.filter(name=>name.endsWith('.json')&&UUID.test(name.slice(0,-5))))states.push(await this.load(name.slice(0,-5)));return states;}
 async persist(state){state.updatedAt=now();await atomic(this.file(state.plan.id),state);await atomic(path.join(this.directory,'latest-'+state.plan.context.profileId+'.json'),{planId:state.plan.id});await atomic(path.join(this.store.runDir,state.plan.id,'run.json'),{schemaVersion:1,runId:state.plan.id,profileId:state.plan.context.profileId,scenario:'content.create',status:state.status,createdAt:state.plan.createdAt,updatedAt:state.updatedAt,planHash:state.planHash,context:state.plan.context,businessKey:state.plan.input.businessKey,steps:state.steps,results:state.results,sourceWrites:state.sourceWrites,publication:'Knowledge publication follows the approved workflow state (Draft or Published). Checkout/revision and source content updates remain unsupported.'});return frozen(state);}
 async inspect(profile,input,id,allowOwned=[],{signal}={}){
  const inspected=await this.people.inspect(profile,id,[],{signal}),payload={actor:inspected.payload.actor,authority:null,references:{},operations:[],blockers:[...inspected.payload.blockers],notificationConsequences:'Normal source business rules, audit and notifications may run. Knowledge is created with the approved workflow state (Draft or Published). Existing-record edits, user/role changes and connector deployment stay out of scope.'},observations=new Map();
  const block=(code,message)=>payload.blockers.push({code,message});
  if(payload.blockers.length)return {payload,observations};
  if(inspected.payload.operations.some(person=>person.kind!=='reuse')){block('content_people_not_ready','All configured people must already exist before content creation.');return {payload,observations};}
  try{
   const dictionary=rows(await this.adapter.readBootstrap(profile,'contentDictionary',{}, {signal}),'Content schema'),choices=rows(await this.adapter.readBootstrap(profile,'contentChoices',{}, {signal}),'Installed content choices'),bases=rows(await this.adapter.readBootstrap(profile,'knowledgeBases',{}, {signal}),'Knowledge bases');
   payload.authority={people:inspected.payload, dictionary:ordered(dictionary),choices:ordered(choices),knowledgeBase:null};payload.references.humanChoice=inspected.payload.authority.humanChoice;
   const reference=(sourceId,label)=>{const entry=inspected.payload.operations.find(person=>person.sourceId===sourceId);if(!entry)throw fail('The '+label+' must be an exact existing person in this config.','content_reference_invalid');const row=inspected.observations.get(entry.personId).row;return {sysId:row.sys_id,userName:row.user_name,email:row.email.toLowerCase(),displayName:entry.displayName};};
   const field=(table,key)=>{let matches=dictionary.filter(row=>row.name===table&&row.element===key);if(!matches.length&&table==='incident')matches=dictionary.filter(row=>row.name==='task'&&row.element===key);if(matches.length!==1||!SYSID.test(matches[0].sys_id||''))throw fail('Field '+table+'.'+key+' is not uniquely readable.','content_schema_invalid');return matches[0];};
   const validateFields=(table,fields)=>{const references={caller_id:'sys_user',author:'sys_user',kb_knowledge_base:'kb_knowledge_base'};for(const [key,value]of Object.entries(fields)){if(key==='sys_id')continue;const meta=field(table,key);if(![false,'false'].includes(meta.read_only))throw fail('Field '+key+' is not confirmed writable.','content_schema_invalid');const types=references[key]?['reference']:key==='text'?['html','translated_html']:key==='active'?['boolean']:['string','integer','workflow','choice'];if(!types.includes(meta.internal_type)||(references[key]&&meta.reference!==references[key]))throw fail('Unsupported source type/reference for '+key+'.','content_schema_invalid');if(typeof value==='string'&&(!/^\d+$/.test(String(meta.max_length))||value.length>Number(meta.max_length)))throw fail('Content exceeds the installed '+key+' field length.','content_schema_invalid');}};
   const choice=(table,key,value,label)=>{let matching=choices.filter(row=>row.name===table&&row.element===key&&row.language==='en'&&[false,'false'].includes(row.inactive));if(!matching.length&&table==='incident')matching=choices.filter(row=>row.name==='task'&&row.element===key&&row.language==='en'&&[false,'false'].includes(row.inactive));matching=matching.filter(row=>label?row.label===label:row.value===value);if(matching.length!==1)throw fail('A unique installed '+key+' choice is required.','content_choice_invalid');return matching[0].value;};
   if(input.incident){const opId=operationId(id,'incident'),fields={sys_id:opId.replaceAll('-',''),...input.incident,correlation_id:'SNDS:'+opId};payload.references.caller=reference(fields.caller_id,'caller');for(const key of ['category','impact','urgency'])if(fields[key]!==undefined)choice('incident',key,fields[key]);validateFields('incident',fields);payload.operations.push({operationId:opId,table:'incident',fields});}
   if(input.knowledge){
    const opId=operationId(id,'knowledge'),workflowLabel=input.knowledge.publish?'Published':'Draft',fields={sys_id:opId.replaceAll('-',''),short_description:input.knowledge.short_description,text:input.knowledge.text,author:input.knowledge.author,kb_knowledge_base:input.knowledge.kb_knowledge_base,workflow_state:choice('kb_knowledge','workflow_state',null,workflowLabel),active:true};
    payload.references.author=reference(fields.author,'author');
    const person=inspected.payload.operations.find(person=>person.sourceId===fields.author),grants=inspected.observations.get(person.personId).grants;
    const role=inspected.payload.authority.roles.find(role=>['knowledge_admin','knowledge'].includes(role.name)&&grants.some(grant=>grant.role===role.sysId));
    if(!role)throw fail('Author needs a verified planned Knowledge role; no role will be granted.','content_author_role');
    payload.references.author.roleName=role.name;payload.references.author.roleId=role.sysId;
    const matches=bases.filter(base=>base.sys_id===fields.kb_knowledge_base&&bool(base.active));
    if(matches.length!==1||typeof matches[0].title!=='string')throw fail('The selected Knowledge base must be uniquely readable and active.','content_base_invalid');
    payload.authority.knowledgeBase=matches[0];
    validateFields('kb_knowledge',fields);
    payload.operations.push({operationId:opId,table:'kb_knowledge',fields,workflowLabel,publication:input.knowledge.publish?'published':'draft-only-not-published'});
   }
   for(const operation of payload.operations){const fields=operation.fields,options={table:operation.table,recordId:fields.sys_id,title:fields.short_description,...(operation.table==='incident'?{marker:fields.correlation_id}:{baseId:fields.kb_knowledge_base})};const existing=rows(await this.adapter.readBootstrap(profile,'contentLookup',options,{signal}),'Existing '+operation.table+' lookup');if(existing.length>1)throw fail('Multiple matching source records exist. No duplicate is created.','content_collision');if(existing.length&&(!allowOwned.includes(operation.table)||!owns(existing[0],operation,payload.actor)))throw fail('A source record already matches the title/tracking ID. It is not adopted or edited.','content_collision');observations.set(operation.table,existing[0]||null);}
  }catch(e){if(!e.status)throw e;block(e.code,e.message);}
  return {payload,observations};
 }
 async preview(profileId,revision,value,{signal}={}){
  const input=inputValue(value),profile=await this.store.get(profileId);if(profile.revision!==revision)throw fail('Config changed before content preparation.','stale_profile');
  return this.store.execute(this.store.makeContext(profile,'content.create',input),input,async current=>{
   const previous=(await this.states()).filter(state=>state.plan.context.pdiUrl===current.pdiUrl);
   if(previous.some(state=>state.sourceWrites&&state.status!=='confirmed'))throw fail('Reconcile prior content writes on this PDI before preparing another run.','reconciliation_required');
   const completed=previous.find(state=>state.status==='confirmed'&&state.plan.input.businessKey===input.businessKey);
   if(completed){if(digest(completed.plan.input)!==digest(input)||completed.plan.context.profileId!==current.id)throw fail('This content-run key already belongs to different completed inputs.','content_key_conflict');const checked=await this.inspect(current,input,completed.plan.id,completed.plan.payload.operations.map(op=>op.table),{signal});if(checked.payload.blockers.length||completed.plan.payload.operations.some(op=>!owns(checked.observations.get(op.table),op,completed.plan.payload.actor)))throw fail('Previously completed source content changed. Inspect it instead of creating duplicates.','content_changed');return frozen(completed);}
   const id=randomUUID(),{payload}=await this.inspect(current,input,id,[],{signal});if(typeof this.adapter.contentOperation!=='function')payload.blockers.push({code:'content_writer_missing',message:'The fixed content adapter is unavailable.'});
   const plan=frozen({schemaVersion:1,id,createdAt:now(),expiresAt:new Date(Date.now()+30*60*1000).toISOString(),context:this.store.makeContext(current,'content.create',payload,payload.actor),input,payload});return this.persist({plan,planHash:digest(plan),status:payload.blockers.length?'blocked':'preview',approval:null,sourceWrites:false,steps:[],results:[]});
  });
 }
 async approve(id,hash,confirmed){if(confirmed!==true)throw fail('Exact content changes require explicit approval.','approval_required');const saved=await this.load(id);return this.store.execute(saved.plan.context,saved.plan.payload,async()=>{const state=await this.load(id),resume=state.status==='partial'&&!state.steps.some(step=>['attempting','uncertain'].includes(step.status));if(state.planHash!==hash||state.plan.payload.blockers.length||(!resume&&state.status!=='preview')||Date.parse(state.plan.expiresAt)<=Date.now())throw fail('Content approval is stale, blocked or requires reconciliation.','stale_plan');state.approval={planHash:hash,approvedAt:now()};state.status='approved';return this.persist(state);});}
 async apply(id,hash,{signal,reconcile=false}={}){
  const saved=await this.load(id);return this.store.execute(saved.plan.context,saved.plan.payload,async profile=>{
   const state=await this.load(id),plan=state.plan;if(hash!==state.planHash||state.approval?.planHash!==hash||plan.payload.blockers.length)throw fail('An exact approved content plan is required.','approval_required');if(state.status==='confirmed')return frozen(state);
   if((!reconcile&&state.status!=='approved')||(reconcile&&!['partial','uncertain','attempting'].includes(state.status)))throw fail('Inspect/reconcile prior attempts instead of repeating source writes.','reconciliation_required');if(!reconcile&&Date.parse(plan.expiresAt)<=Date.now())throw fail('Content approval expired.','stale_plan');
   const fresh=async()=>{const allowed=state.steps.filter(step=>['confirmed','attempting','uncertain'].includes(step.status)).map(step=>step.table),result=await this.inspect(profile,plan.input,id,allowed,{signal});if(result.payload.blockers.length||digest(result.payload)!==digest(plan.payload))throw fail('Source actor, references, schema, choices or content changed after approval.','content_changed');return result.observations;};
   const saveResult=(operation,row)=>{state.results=state.results.filter(result=>result.table!==operation.table);state.results.push({table:operation.table,sysId:row.sys_id,number:row.number,title:row.short_description,state:operation.table==='incident'?row.state:row.workflow_state,publication:operation.table==='kb_knowledge'?(operation.publication||'draft-only-not-published'):'not-applicable',sourceUrl:profile.pdiUrl+'/'+operation.table+'.do?sys_id='+row.sys_id});};
   try{
    let observations=await fresh();
    if(reconcile){for(const operation of plan.payload.operations){const step=state.steps.find(step=>step.table===operation.table),row=observations.get(operation.table);if(step&&['attempting','uncertain'].includes(step.status)&&owns(row,operation,plan.payload.actor)){step.status='confirmed';step.sysId=row.sys_id;saveResult(operation,row);}}state.status=state.steps.some(step=>['attempting','uncertain'].includes(step.status))?'uncertain':state.steps.length===plan.payload.operations.length&&state.steps.every(step=>step.status==='confirmed')?'confirmed':'partial';return this.persist(state);}
    for(const operation of plan.payload.operations){let step=state.steps.find(step=>step.table===operation.table);if(step?.status==='confirmed')continue;if(step&&['attempting','uncertain'].includes(step.status))throw fail('An uncertain content write must not be repeated.','reconciliation_required');observations=await fresh();if(observations.get(operation.table))throw fail('The record appeared before this write. No source record is adopted.','content_collision');if(!step){step={table:operation.table,name:'create-'+operation.table};state.steps.push(step);}step.status='attempting';state.status='attempting';state.sourceWrites=true;await this.persist(state);
     const result=await this.adapter.contentOperation(profile,plan.payload.actor,operation,plan.payload.authority.people.authority.bootstrap.schema.machineChoice.value,plan.payload.references,{signal});
     if(result.outcome!=='created'||!owns(result.row,operation,plan.payload.actor)){step.status=result.outcome==='rejected'?'rejected':'uncertain';state.status=step.status==='uncertain'?'uncertain':'partial';await this.persist(state);return frozen(state);}step.status='confirmed';step.sysId=result.row.sys_id;saveResult(operation,result.row);await this.persist(state);
     observations=await fresh();if(!owns(observations.get(operation.table),operation,plan.payload.actor))throw fail('Created content was not confirmed by an exact source read-back.','content_readback_mismatch');
    }
    observations=await fresh();for(const operation of plan.payload.operations){const row=observations.get(operation.table);if(!owns(row,operation,plan.payload.actor))throw fail('Final content read-back differs from the approved payload.','content_readback_mismatch');saveResult(operation,row);}state.status='confirmed';return this.persist(state);
   }catch(e){for(const step of state.steps)if(step.status==='attempting')step.status='uncertain';state.status=state.steps.some(step=>step.status==='uncertain')?'uncertain':state.sourceWrites?'partial':'failed';state.failureCode=e.code||'content_internal_error';await this.persist(state);throw fail('Content operation stopped ('+state.failureCode+'). Inspect the existing journal; do not create a replacement. ',state.failureCode);}
  });
 }
 async status(id){return frozen(await this.load(id));}
 async statusForProfile(profileId){await this.store.get(profileId);const latest=await readJson(path.join(this.directory,'latest-'+profileId+'.json'));return latest?this.status(latest.planId):null;}
}
module.exports={ContentProvisioning,inputValue,owns,normalizeHtml};
