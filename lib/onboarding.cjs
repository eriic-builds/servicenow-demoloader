'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { error, atomic, readJson } = require('./profiles.cjs');
const { digest, frozen } = require('./execution.cjs');
const SYSID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STANDARD_ROLES = new Set(['itil', 'knowledge', 'knowledge_admin', 'itil_admin']);
const now = () => new Date().toISOString();
const bool = value => value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
function safeFailure(e) {
  if (['CANCELLED','ABORT_ERR'].includes(e?.code) || e?.name === 'AbortError') return { code: 'onboarding_cancelled', uncertain: true };
  if (['PDI_NETWORK','BROWSER_NETWORK','TIMED_OUT'].includes(e?.code) || e?.name === 'TimeoutError') return { code: 'onboarding_network', uncertain: true };
  if (['storage_error','EIO','ENOSPC','EACCES','EPERM'].includes(e?.code)) return { code: 'onboarding_storage_error', uncertain: false };
  if (['HELPER_PROTOCOL','BROWSER_PROTOCOL','verification_invalid'].includes(e?.code)) return { code: 'onboarding_protocol_error', uncertain: false };
  if (['metadata_invalid','invalid_input','stale_plan','stale_profile','BROWSER_SCOPE','BROWSER_ACTOR'].includes(e?.code)) return { code: 'onboarding_validation_error', uncertain: false };
  return { code: 'onboarding_internal_error', uncertain: false };
}
function str(value, max = 120) { if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw error('Instance metadata is incomplete or invalid. No account changes are permitted.', 'metadata_invalid', 409); return value; }
function sysid(value) { if (typeof value !== 'string' || !SYSID.test(value)) throw error('Instance returned an invalid record identity.', 'metadata_invalid', 409); return value; }
function rolesInput(value) {
  if (!Array.isArray(value) || value.length > 4 || value.some(role => !STANDARD_ROLES.has(role)) || new Set(value).size !== value.length) throw error('Select installed standard roles explicitly. No automatic admin grants are supported.');
  return [...value].sort();
}
function record(row) { return { sysId: sysid(row.sys_id), userName: str(row.user_name), active: bool(row.active), identityType: typeof row.identity_type === 'string' ? str(row.identity_type) : null, apiOnly: bool(row.web_service_access_only), source: typeof row.source === 'string' ? str(row.source, 200) : null }; }
function catalog(data) {
  if (!data || data.outcome !== 'readable' || data.truncated) throw error('Role metadata is unavailable or incomplete; ask the instance administrator to repair access manually.', 'roles_unavailable', 409);
  return data.rows.map(row => ({ sysId: sysid(row.sys_id), name: str(row.name) })).sort((a, b) => a.sysId.localeCompare(b.sysId));
}
function snapshot(profile, requestedRoles, data, creationId = null) {
  const machineBootstrap = profile.bootstrapMode === 'machine';
  const blockers = [], add = (code, message) => blockers.push({ code, message });
  const result = { mode: profile.integrationMode === 'create' ? 'create' : 'reuse', actor: null, target: null, schema: null, roles: [], existingRoles: [], proposedFields: {}, sourceChanges: [], blockers };
  if (!['api','browser'].includes(data?.access)) {
    const outcome = ['missing','unreadable','identityMismatch','unauthorized','forbidden','interactiveRequired','loginFailed','network','response'].includes(data?.access) ? data.access : 'response';
    const messages = {
      missing: 'No encrypted provisioning credential is saved. Enter the selected account password under Access and choose Save password before discovery. No sign-in was started.',
      unreadable: 'The Windows-protected admin credential cannot be opened. No account was changed.',
      identityMismatch: 'The protected credential belongs to a different exact host/user/purpose.',
      unauthorized: 'Admin API access was rejected (401). Browser login may still work, but no authenticated browser discovery was established. Do not weaken authentication policy.',
      forbidden: 'The instance denied admin metadata reads. No ACLs or roles were changed.',
      interactiveRequired: 'Normal isolated browser login is blocked by MFA/SSO, unsupported login navigation or an attended step. No browser fallback success was inferred; no cookies were copied or policy weakened.',
      loginFailed: 'Normal isolated browser login failed to establish the requested admin actor. No account changes were made.',
      network: 'The instance read timed out or failed. Authentication and account state remain unknown.',
      response: 'The instance returned an unsupported response. No authentication success is inferred.'
    };
    add(outcome, messages[outcome]); return result;
  }
  try {
    if (data.actor.outcome !== 'readable' || data.actor.rows.length !== 1 || data.actor.truncated) throw error('The authenticated admin username must resolve to one exact active instance record.', 'actor_mismatch', 409);
    const actor = record(data.actor.rows[0]);
    if (actor.userName !== (machineBootstrap ? profile.integrationUser : profile.adminUser) || actor.active !== true || (machineBootstrap ? actor.apiOnly !== true || data.credentialPurpose !== 'integration' || data.access !== 'api' : actor.apiOnly === true)) throw error('The provisioning principal is not the exact configured active identity and credential purpose.', 'actor_mismatch', 409);
    const installed = catalog(data.roles), adminRoles = installed.filter(role => role.name === 'admin');
    if (adminRoles.length !== 1 || data.actorGrants?.outcome !== 'readable' || data.actorGrants.truncated || !data.actorGrants.rows.some(row => row.user === actor.sysId && row.role === adminRoles[0].sysId)) throw error('The exact authenticated admin does not have a readable installed admin role assignment.', 'admin_unverified', 409);
    if (data.access === 'browser' && (!data.browserActor || data.browserActor.sysId !== actor.sysId || data.browserActor.userName !== actor.userName || data.browserActor.authMethod !== 'isolated-browser-session' || data.browserActor.impersonating !== false)) throw error('The authenticated isolated browser actor does not match the exact admin record.', 'actor_mismatch', 409);
    result.actor = { sysId: actor.sysId, userName: actor.userName, authMethod: machineBootstrap ? 'basic-machine-principal' : data.access === 'browser' ? 'isolated-browser-session' : 'basic-exact-principal', impersonating: false };
    for (const name of requestedRoles) {
      const matches = installed.filter(role => role.name === name);
      if (matches.length !== 1) add('role_missing', 'Selected role ' + name + ' is not uniquely installed. No replacement role is inferred.');
      else result.roles.push(matches[0]);
    }
    if (data.dictionary?.outcome !== 'readable' || data.dictionary.truncated || data.choices?.outcome !== 'readable' || data.choices.truncated) throw error('Installed identity metadata cannot be read. Machine creation/reuse is blocked.', 'schema_unavailable', 409);
    const required = ['user_name', 'active', 'identity_type', 'web_service_access_only'];
    const fields = required.map(name => {
      const matches = data.dictionary.rows.filter(row => row.name === 'sys_user' && row.element === name);
      if (matches.length !== 1 || typeof matches[0].internal_type !== 'string' || !matches[0].internal_type) throw error('Required sys_user field ' + name + ' is not uniquely discoverable.', 'schema_missing', 409);
      return { name, dictionaryId: sysid(matches[0].sys_id), internalType: str(matches[0].internal_type), readOnly: bool(matches[0].read_only), unique: bool(matches[0].unique), maxLength: /^\d+$/.test(String(matches[0].max_length)) ? Number(matches[0].max_length) : null };
    });
    const machineChoices = data.choices.rows.filter(row => row.name === 'sys_user' && row.element === 'identity_type' && row.label === 'Machine' && row.language === 'en' && bool(row.inactive) === false);
    if (machineChoices.length !== 1 || !str(machineChoices[0].value)) throw error('An active installed Machine identity choice was not uniquely discovered. Numeric or cross-instance values are never guessed.', 'machine_choice_missing', 409);
    result.schema = { fields, machineChoice: { sysId: sysid(machineChoices[0].sys_id), value: machineChoices[0].value, label: 'Machine' } };
    if (machineBootstrap && actor.identityType !== result.schema.machineChoice.value) throw error('The provisioning identity is not the installed Machine type.', 'actor_mismatch', 409);
    result.proposedFields = { user_name: profile.integrationUser, active: true, identity_type: result.schema.machineChoice.value, web_service_access_only: true };
    if (data.machine?.outcome !== 'readable') throw error('Exact integration-user discovery was denied. This is not proof that the username is free.', 'target_unknown', 409);
    if (data.machine.truncated || data.machine.rows.length > 1) throw error('The requested username discovery is truncated or collides with multiple records. Resolve manually; no user is adopted.', 'duplicate_collision', 409);
    if (data.machine.rows.length === 1) result.target = record(data.machine.rows[0]);
    if (result.target && result.target.userName !== profile.integrationUser) throw error('The instance returned a different exact username.', 'target_mismatch', 409);
    if (machineBootstrap && (!result.target || result.target.sysId !== actor.sysId)) throw error('The pre-created API Machine must exist and match the authenticated actor. It cannot bootstrap its own missing account.', 'bootstrap_required', 409);
    if (result.target && result.mode === 'create') result.mode = 'reuse';
    if (result.mode === 'create') {
      const createFields = ['source', 'user_password', 'password_needs_reset'].map(name => {
        const rows = data.dictionary.rows.filter(row => row.name === 'sys_user' && row.element === name);
        if (rows.length !== 1) throw error('Creation requires readable ' + name + ' metadata.', 'creation_schema_missing', 409);
        const row = rows[0];
        return { name, dictionaryId: sysid(row.sys_id), internalType: str(row.internal_type), readOnly: bool(row.read_only), maxLength: /^\d+$/.test(String(row.max_length)) ? Number(row.max_length) : null };
      });
      result.schema.createFields = createFields;
      const loginField = fields.find(field => field.name === 'user_name');
      if (loginField.unique !== true || loginField.maxLength < profile.integrationUser.length) add('uniqueness_unverified', 'A source-enforced unique user ID and sufficient field length must be proven before creation. No index or ACL will be changed.');
      if (fields.find(field => field.name === 'user_name').internalType !== 'string' || fields.find(field => field.name === 'active').internalType !== 'boolean' || fields.find(field => field.name === 'web_service_access_only').internalType !== 'boolean' || createFields.find(field => field.name === 'source').internalType !== 'string' || !['password','password2'].includes(createFields.find(field => field.name === 'user_password').internalType) || createFields.find(field => field.name === 'password_needs_reset').internalType !== 'boolean') add('creation_schema_invalid', 'Installed field types do not support this bounded creation path.');
      if (fields.some(field => field.readOnly !== false)) add('fields_read_only', 'One or more proposed fields are read-only or their writability is unknown.');
      if (createFields.some(field => field.readOnly !== false) || createFields.find(field => field.name === 'source').maxLength < 50 || createFields.find(field => field.name === 'user_password').maxLength < 68) add('creation_fields_unverified', 'Creation requires writable ownership/password fields with proven sufficient lengths.');
      if (data.access !== 'api') add('creation_api_required', 'Creation requires the exact admin to authenticate directly to the Table API. Isolated browser fallback stays read-only; authentication policy is not weakened.');
      if (!UUID.test(creationId || '')) add('creation_id_missing', 'A controller-owned operation ID is required before preparing creation.');
      else {
        result.proposedFields = { sys_id: creationId.replace(/-/g, ''), ...result.proposedFields, source: 'SN-DemoSeeder:' + creationId, password_needs_reset: false };
        result.sourceChanges = [{ operation: 'create-machine', table: 'sys_user', fields: result.proposedFields, credential: 'Independent random password, staged with Windows encryption before the write; never shown or exported.' }, ...result.roles.map(role => ({ operation: 'grant-role', table: 'sys_user_has_role', fields: { sys_id: digest([creationId, role.sysId]).slice(0,32), user: result.proposedFields.sys_id, role: role.sysId }, roleName: role.name }))];
      }
      result.notificationConsequences = 'Normal ServiceNow business rules, audit and notifications may run. No notification suppression, authentication-policy changes or connector deployment.';
    } else {
      if (!result.target) add('target_missing', 'The existing Machine username was not found. Nothing is created in reuse mode.');
      else {
        if (result.target.active !== true || result.target.apiOnly !== true || result.target.identityType !== result.schema.machineChoice.value) add('target_requires_manual_repair', 'Existing account must already be Active, Machine and web-service-only. Reuse makes no password/type/role changes. Repair manually only with separate authorization.');
        result.existingRoles = catalog(data.existingRoles);
        if (data.machineGrants?.outcome !== 'readable' || data.machineGrants.truncated || data.machineGrants.rows.some(row => row.user !== result.target.sysId || !result.existingRoles.some(role => role.sysId === row.role))) throw error('Existing assignments could not be fully resolved. Reuse cannot assume permissions.', 'roles_unavailable', 409);
        const assigned = new Set(data.machineGrants.rows.map(row => row.role));
        if (result.roles.some(role => !assigned.has(role.sysId))) add('roles_require_manual_repair', 'Selected roles are not already assigned. Reuse never grants or repairs roles automatically.');
      }
    }
  } catch (e) { if (!e.status) throw error('Instance metadata could not be parsed. No writes are permitted.', 'metadata_invalid', 409); add(e.code, e.message); }
  return result;
}
class Onboarding {
  constructor({ store, adapter }) { this.store = store; this.adapter = adapter; this.directory = path.join(store.runtimeHome, 'state', 'onboarding'); }
  file(planId) { if (!UUID.test(planId || '')) throw error('Choose a valid onboarding preview ID.'); return path.join(this.directory, planId + '.json'); }
  async load(planId) {
    const state = await readJson(this.file(planId));
    if (!state) throw error('Onboarding preview not found on this controller.', 'not_found', 404);
    if (state.plan?.id !== planId || digest(state.plan) !== state.planHash || !['preview','blocked','approved','attempting','confirmed','partial','uncertain','failed'].includes(state.status)) throw error('Stored onboarding authority is corrupt. Do not apply it.', 'plan_corrupt', 409);
    return state;
  }
  async persist(state) {
    state.updatedAt = now();
    await atomic(this.file(state.plan.id), state);
    await atomic(path.join(this.directory, 'latest-' + state.plan.context.profileId + '.json'), { planId: state.plan.id });
    await atomic(path.join(this.store.runDir, state.plan.id, 'run.json'), { schemaVersion: 1, runId: state.plan.id, profileId: state.plan.context.profileId, scenario: state.plan.context.operation, status: state.status, createdAt: state.plan.createdAt, updatedAt: state.updatedAt, planHash: state.planHash, context: state.plan.context, target: state.plan.payload.target, steps: state.steps, readiness: state.readiness || null, sourceWrites: state.sourceWrites === true, mapping: state.mapping || null });
    return frozen(state);
  }
  async preview(profileId, expectedRevision, roles, { signal } = {}) {
    const requestedRoles = rolesInput(roles), profile = await this.store.get(profileId);
    if (profile.revision !== expectedRevision) throw error('Config changed before discovery.', 'stale_profile', 409);
    if (!/^[A-Za-z0-9_.@-]{1,120}$/.test(profile.adminUser) || !/^[A-Za-z0-9_.@-]{1,120}$/.test(profile.integrationUser)) throw error('This bounded onboarding path requires an exact simple login ID without encoded-query characters.');
    const input = { roles: requestedRoles }, discoveryContext = this.store.makeContext(profile, 'onboarding.discover', input);
    return this.store.execute(discoveryContext, input, async current => {
      if (typeof this.adapter.discoverOnboarding !== 'function') throw error('Instance onboarding discovery is unavailable.', 'not_implemented', 409);
      await this.assertNoUnresolved(current);
      const planId = randomUUID();
      const payload = snapshot(current, requestedRoles, await this.adapter.discoverOnboarding(current, requestedRoles, { signal }), planId);
      if (payload.mode === 'create' && typeof this.adapter.machineOperation !== 'function') payload.blockers.push({code:'creation_unsupported',message:'This adapter does not implement guarded Machine creation.'});
      const context = this.store.makeContext(current, 'onboarding.' + payload.mode, payload, payload.actor);
      const plan = frozen({ schemaVersion: 1, id: planId, createdAt: now(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), context, requestedRoles, payload });
      return this.persist({ plan, planHash: digest(plan), status: payload.blockers.length ? 'blocked' : 'preview', approval: null, steps: [{ name: 'discovery', status: payload.blockers.length ? 'blocked' : 'confirmed', at: now() }], sourceWrites: false });
    });
  }
  async approve(planId, planHash, confirmed) {
    if (confirmed !== true) throw error('Review the exact preview and separately confirm approval.', 'approval_required', 409);
    const saved = await this.load(planId);
    return this.store.execute(saved.plan.context, saved.plan.payload, async () => {
      const state = await this.load(planId);
      const resumable = state.plan.payload.mode === 'create' && state.status === 'partial' && !state.steps.some(step => ['attempting','uncertain'].includes(step.status));
      if (state.planHash !== planHash || (state.status !== 'preview' && !resumable) || Date.parse(state.plan.expiresAt) <= Date.now()) throw error('Approval is stale, mismatched or unavailable. Inspect/reconcile interrupted setup before retrying.', 'stale_plan', 409);
      if (!['reuse','create'].includes(state.plan.payload.mode) || state.plan.payload.blockers.length || (state.plan.payload.mode === 'create' && typeof this.adapter.machineOperation !== 'function')) throw error('This preview contains unsupported or blocked changes.', 'creation_unsupported', 409);
      state.status = 'approved'; state.approval = { planHash, approvedAt: now(), action: 'explicit-local-user-confirmation' };
      state.steps.push({ name: 'approval', status: 'confirmed', at: now() });
      return this.persist(state);
    });
  }
  async apply(planId, planHash, { signal, reconcile = false } = {}) {
    const saved = await this.load(planId);
    if (saved.plan.payload.mode === 'create') return this.applyCreation(saved, planHash, {signal, reconcile});
    return this.store.execute(saved.plan.context, saved.plan.payload, async (profile, lease) => {
      const state = await this.load(planId);
      if (planHash !== state.planHash || state.approval?.planHash !== planHash || state.plan.payload.mode !== 'reuse' || state.plan.payload.blockers.length) throw error('An exact supported approved reuse plan is required. Creation remains disabled.', 'approval_required', 409);
      if (state.status === 'confirmed') return frozen(state);
      if ((!reconcile && state.status !== 'approved') || (reconcile && !['attempting','partial','uncertain'].includes(state.status))) throw error('This attempt requires status inspection/reconciliation, not blind retry.', 'reconciliation_required', 409);
      if (!reconcile && Date.parse(state.plan.expiresAt) <= Date.now()) throw error('Approved preview expired. Prepare a fresh one.', 'stale_plan', 409);
      const step = { name: reconcile ? 'reconciliation' : 'reuse-verification', status: 'attempting', at: now() };
      state.steps.push(step); state.status = 'attempting'; state.readiness = null;
      try { await this.persist(state); } catch (e) { const failure = safeFailure(e); throw error('The local attempting journal could not be saved (' + failure.code + '). Verification was not started; no source writes were performed.', failure.code, 500); }
      try {
        await this.store.invalidate(profile, 'integration', lease);
        const refreshed = snapshot(profile, state.plan.requestedRoles, await this.adapter.discoverOnboarding(profile, state.plan.requestedRoles, { signal }), state.plan.id);
        if (digest(refreshed) !== digest(state.plan.payload)) {
          step.status = 'partial'; step.outcome = 'discovery_changed'; state.status = 'partial';
          return this.persist(state);
        }
        const verification = await this.adapter.verifyMachine(profile, state.plan.payload.target.sysId, { signal, identityType: state.plan.payload.schema.machineChoice.value });
        const supported = ['readable','empty-uncertain','missing','unreadable','identityMismatch','unauthorized','forbidden','interactiveRequired','response','network','not-checked'];
        if (!verification || !['authenticated','blocked'].includes(verification.status) || verification.writeAccessTested !== false || !supported.includes(verification.incident) || !supported.includes(verification.knowledge)) throw error('Machine verification returned an unsupported result.', 'verification_invalid', 409);
        const uncertain = [verification.incident, verification.knowledge, verification.outcome].includes('network');
        state.status = uncertain ? 'uncertain' : verification.status === 'authenticated' ? 'confirmed' : 'partial';
        step.status = state.status; step.incident = verification.incident; step.knowledge = verification.knowledge;
        state.readiness = { identity: verification.status === 'authenticated' ? 'verified' : 'blocked', incident: verification.incident, knowledge: verification.knowledge, writes: 'not-tested', connector: 'unknown', seeding: 'not-implemented' };
        await this.persist(state);
        await this.store.recordCheck(profile, 'integration', { status: verification.status, checkedAt: now(), message: 'Onboarding reuse: incident ' + verification.incident + '; Knowledge ' + verification.knowledge + '. No passwords, roles or source records changed; write and connector readiness are unverified.', writeAccessTested: false, onboardingPlanId: planId }, lease);
        return frozen(state);
      } catch (e) {
        const failure = safeFailure(e);
        state.status = failure.uncertain ? 'uncertain' : 'failed'; step.status = state.status; step.failureCode = failure.code; state.readiness = null;
        try { await this.persist(state); } catch (journalError) { const journalFailure = safeFailure(journalError); throw error('The failure journal could not be saved (' + journalFailure.code + '; original ' + failure.code + '). No source writes were performed; local status is not confirmed.', journalFailure.code, 500); }
        if (failure.uncertain) return frozen(state);
        throw error('Onboarding verification failed (' + failure.code + '). Inspect the local journal and prepare a fresh preview; no source writes were performed.', failure.code, 500);
      }
    });
  }
  async assertNoUnresolved(profile) {
    let entries;
    try { entries = await fs.readdir(this.directory); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const entry of entries.filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5)))) {
      const state = await this.load(entry.slice(0, -5));
      if (state.plan.context.pdiUrl === profile.pdiUrl && state.plan.context.integrationUser.toLowerCase() === profile.integrationUser.toLowerCase() && state.plan.payload.mode === 'create' && state.sourceWrites === true && state.status !== 'confirmed') throw error('An earlier creation attempt for this physical account needs reconciliation. A new preview cannot bypass it.', 'reconciliation_required', 409);
    }
  }
  async existingTarget(profile) {
    const state = await this.statusForProfile(profile.id);
    const targetEstablished = state && (state.plan.payload.mode === 'reuse' || (state.plan.payload.mode === 'create' && state.status === 'confirmed' && state.mapping?.sysId === state.plan.payload.proposedFields.sys_id && state.readiness?.identity === 'verified'));
    return Boolean(targetEstablished && !state.plan.payload.blockers.length && ['preview','approved','confirmed'].includes(state.status) && (state.status === 'confirmed' || Date.parse(state.plan.expiresAt) > Date.now()) && state.plan.context.profileRevision === profile.revision && state.plan.context.pdiUrl === profile.pdiUrl && state.plan.context.integrationUser === profile.integrationUser);
  }
  async applyCreation(saved, planHash, {signal, reconcile}) {
    return this.store.execute(saved.plan.context, saved.plan.payload, async (profile, lease) => {
      const state = await this.load(saved.plan.id), plan = state.plan, expected = plan.payload.proposedFields;
      if (planHash !== state.planHash || state.approval?.planHash !== planHash || plan.payload.blockers.length || typeof this.adapter.machineOperation !== 'function') throw error('An exact approved, supported creation preview is required.', 'approval_required', 409);
      if (state.status === 'confirmed') return frozen(state);
      if ((!reconcile && state.status !== 'approved') || (reconcile && !['attempting','partial','uncertain'].includes(state.status))) throw error('Inspect and reconcile the existing attempt before another action.', 'reconciliation_required', 409);
      if (!reconcile && Date.parse(plan.expiresAt) <= Date.now()) throw error('Creation approval expired. No new writes are permitted.', 'stale_plan', 409);
      const owned = data => {
        const row = data.machine.rows[0];
        return data.machine.rows.length === 1 && row.sys_id === expected.sys_id && row.user_name === expected.user_name && row.source === expected.source && bool(row.active) === true && bool(row.web_service_access_only) === true && row.identity_type === expected.identity_type;
      };
      const read = async () => {
        const data = await this.adapter.discoverOnboarding(profile, plan.requestedRoles, {signal});
        if (data.machine?.outcome !== 'readable' || data.machine.truncated) throw error('Exact account visibility is not proven. Nothing will be retried.', 'target_unknown', 409);
        // Compare unchanged authority/schema separately from the account this plan creates.
        const metadata = snapshot(profile, plan.requestedRoles, {...data, machine:{outcome:'readable',rows:[],truncated:false}}, plan.id);
        if (digest(metadata) !== digest(plan.payload)) throw error('The approved actor, schema or role metadata changed.', 'stale_plan', 409);
        return data;
      };
      const grants = data => {
        const rows = data.machineGrants;
        if (rows?.outcome !== 'readable' || rows.truncated || rows.rows.some(row => row.user !== expected.sys_id || !SYSID.test(row.sys_id || '') || !SYSID.test(row.role || ''))) throw error('Complete role assignments cannot be established.', 'roles_unavailable', 409);
        if (catalog(data.existingRoles).some(role => ['admin','security_admin'].includes(role.name))) throw error('The newly created account has unexpected administrative access. No automatic repair is performed.', 'unexpected_admin', 409);
        return rows.rows;
      };
      const write = async (name, action, options = {}) => {
        const previous = state.steps.find(step => step.name === name);
        if (previous?.status === 'confirmed') return true;
        if (previous && ['attempting','uncertain'].includes(previous.status)) throw error('An uncertain write must be reconciled, never repeated.', 'reconciliation_required', 409);
        const step = previous || {name, write:true};
        if (!previous) state.steps.push(step);
        step.status = 'attempting'; step.at = now(); state.status = 'attempting'; state.sourceWrites = true;
        await this.persist(state);
        const result = await this.adapter.machineOperation(profile, action, plan, {signal, ...options});
        if (result.outcome !== 'created') {
          step.status = result.outcome === 'rejected' ? 'rejected' : 'uncertain';
          step.outcome = result.outcome; state.status = result.outcome === 'rejected' ? 'partial' : 'uncertain';
          await this.persist(state); return false;
        }
        const row = result.row;
        const matches = action === 'CreateMachine' ? row && row.sys_id === expected.sys_id && row.user_name === expected.user_name && row.source === expected.source && bool(row.active) === true && bool(row.web_service_access_only) === true && row.identity_type === expected.identity_type : row && row.sys_id === options.grantId && row.user === expected.sys_id && row.role === options.role.sysId;
        if (!matches) { step.status = 'uncertain'; step.outcome = 'write_response_mismatch'; state.status = 'uncertain'; await this.persist(state); return false; }
        step.status = 'confirmed'; step.sysId = row.sys_id; await this.persist(state); return true;
      };
      try {
        let data = await read();
        const creation = state.steps.find(step => step.name === 'machine-create');
        if (reconcile) {
          if (!creation || !owned(data)) { state.status = state.sourceWrites ? 'uncertain' : 'partial'; return this.persist(state); }
          if (['attempting','uncertain'].includes(creation.status)) { creation.status = 'confirmed'; creation.sysId = expected.sys_id; }
          const currentGrants = grants(data);
          for (const role of plan.payload.roles) {
            const step = state.steps.find(item => item.name === 'role-' + role.sysId);
            if (step && ['attempting','uncertain'].includes(step.status) && currentGrants.some(row => row.sys_id === digest([plan.id, role.sysId]).slice(0,32) && row.role === role.sysId)) { step.status = 'confirmed'; step.sysId = digest([plan.id, role.sysId]).slice(0,32); }
          }
          state.status = state.steps.some(step => ['attempting','uncertain'].includes(step.status)) ? 'uncertain' : 'partial';
          state.mapping = {sysId:expected.sys_id,userName:expected.user_name,ownership:'created-by-this-operation',source:expected.source};
          return this.persist(state);
        }
        if (!creation || creation.status !== 'confirmed') {
          if (data.machine.rows.length) throw error('The username is no longer absent. No collided account is adopted.', 'username_collision', 409);
          const secret = await this.adapter.machineOperation(profile, 'PrepareMachineSecret', plan, {signal});
          if (secret.outcome !== 'prepared') throw error('Protected credential staging was not confirmed.', 'credential_stage_failed', 409);
          data = await read();
          if (data.machine.rows.length) throw error('The username appeared before creation. No password or role changes were made.', 'username_collision', 409);
          if (!await write('machine-create', 'CreateMachine')) return frozen(state);
          data = await read();
        }
        if (!owned(data)) throw error('The source account does not match this operation-owned ID and marker. No account is adopted or reset.', 'ownership_mismatch', 409);
        state.mapping = {sysId:expected.sys_id,userName:expected.user_name,ownership:'created-by-this-operation',source:expected.source};
        for (const role of plan.payload.roles) {
          data = await read();
          if (!owned(data)) throw error('Created account identity changed before role assignment.', 'ownership_mismatch', 409);
          const rows = grants(data), matching = rows.filter(row => row.role === role.sysId), name = 'role-' + role.sysId;
          if (matching.length > 1) throw error('Role assignments are ambiguous. No duplicate grant is created.', 'duplicate_collision', 409);
          if (matching.length === 1) {
            let step = state.steps.find(item => item.name === name);
            if (!step) { step = {name,write:false}; state.steps.push(step); }
            if (['attempting','uncertain'].includes(step.status)) throw error('An uncertain grant cannot be adopted by role name alone.', 'reconciliation_required', 409);
            step.status = 'confirmed'; step.sysId = matching[0].sys_id; await this.persist(state); continue;
          }
          if (!await write(name, 'CreateMachineRole', {role, grantId:digest([plan.id,role.sysId]).slice(0,32)})) return frozen(state);
        }
        data = await read();
        if (!owned(data) || plan.payload.roles.some(role => !grants(data).some(row => row.role === role.sysId))) throw error('Final account or role read-back did not match the approved plan.', 'verification_invalid', 409);
        const promoted = await this.adapter.machineOperation(profile, 'PromoteMachineSecret', plan, {signal});
        if (promoted.outcome !== 'promoted') throw error('The generated credential could not be installed for this exact identity.', 'credential_stage_failed', 409);
        await this.store.invalidate(profile, 'integration', lease);
        const verification = await this.adapter.verifyMachine(profile, expected.sys_id, {signal,identityType:expected.identity_type});
        const supported = ['readable','empty-uncertain','missing','unreadable','identityMismatch','unauthorized','forbidden','interactiveRequired','response','network','not-checked'];
        if (!verification || !['authenticated','blocked'].includes(verification.status) || verification.writeAccessTested !== false || !supported.includes(verification.incident) || !supported.includes(verification.knowledge) || (verification.status === 'authenticated' && (verification.sysId !== expected.sys_id || verification.userName !== expected.user_name))) throw error('Machine verification returned an invalid response.', 'verification_invalid', 409);
        state.status = verification.status === 'authenticated' ? 'confirmed' : 'partial';
        state.readiness = {identity:verification.status === 'authenticated' ? 'verified' : 'blocked',incident:verification.incident,knowledge:verification.knowledge,writes:'account-and-approved-roles-only',connector:'unknown',seeding:'not-implemented'};
        await this.persist(state);
        await this.store.recordCheck(profile,'integration',{status:verification.status,checkedAt:now(),message:'Machine setup: '+state.status+'. Account and approved role read-back recorded; connector readiness is unknown.',writeAccessTested:false,onboardingPlanId:plan.id},lease);
        return frozen(state);
      } catch (e) {
        for (const step of state.steps) if (step.write && step.status === 'attempting') step.status = 'uncertain';
        state.status = state.steps.some(step => step.status === 'uncertain') ? 'uncertain' : state.sourceWrites ? 'partial' : 'failed';
        state.failureCode = safeFailure(e).code; state.readiness = null;
        await this.persist(state);
        throw error('Machine setup stopped (' + (e.code || state.failureCode) + '). Inspect the durable journal; do not repeat or reset the account.', e.code || state.failureCode, e.status || 500);
      }
    });
  }
  async status(planId) { return frozen(await this.load(planId)); }
  async statusForProfile(profileId) { await this.store.get(profileId); const latest = await readJson(path.join(this.directory, 'latest-' + profileId + '.json')); return latest ? this.status(latest.planId) : null; }
}
module.exports = { Onboarding, snapshot, rolesInput };
