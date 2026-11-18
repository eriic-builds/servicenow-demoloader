'use strict';
const { randomUUID } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = new Set(['requester','support','knowledge-author','knowledge-manager','admin']);
function invalid(message, code = 'invalid_input') { return Object.assign(new Error(message), { code, status: 400 }); }
function normalizePerson(value, tenantInput, { requireId = false, requireTenantDomain = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id','displayName','email','serviceNowUserName','accountIntent','roleProfiles'].includes(key))) throw invalid('Enter a supported manual person plan; credentials are not allowed.');
  const clean = (text, label, max) => { if (typeof text !== 'string' || !text.trim() || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid('Enter a valid ' + label + '.'); return text.trim(); };
  const displayName = clean(value.displayName, 'display name', 160);
  const email = clean(value.email, 'Microsoft demo email', 254).toLowerCase();
  if (!/^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(email) || email.split('@')[0].length > 64) throw invalid('Enter one valid Microsoft demo email, without a display-name wrapper.');
  if (requireTenantDomain && /\.onmicrosoft\.com$/i.test(tenantInput) && email.split('@')[1] !== tenantInput.toLowerCase()) throw invalid('The email must use this config\'s Microsoft tenant domain. For a custom domain, use a config with its tenant GUID.');
  const serviceNowUserName = clean(value.serviceNowUserName, 'ServiceNow user ID', 120);
  if (!/^[A-Za-z0-9_.@+-]+$/.test(serviceNowUserName)) throw invalid('Use the exact ServiceNow login ID, without spaces or encoded-query characters.');
  if (!['existing','create-if-missing'].includes(value.accountIntent)) throw invalid('Choose Already exists or Create if missing.');
  const roles = value.roleProfiles;
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > ROLES.size || roles.some(role => !ROLES.has(role)) || new Set(roles).size !== roles.length) throw invalid('Choose supported planned role profiles.');
  if ((requireId || value.id !== undefined) && !UUID.test(value.id || '')) throw invalid('Select a valid saved person plan.');
  return { id: value.id || randomUUID(), displayName, email, serviceNowUserName, accountIntent: value.accountIntent, roleProfiles: [...roles] };
}
function validatePeople(values, tenantInput) {
  if (!Array.isArray(values) || values.length > 100) throw invalid('At most 100 people can be planned per configuration.');
  const emails = new Set(), users = new Set(), ids = new Set();
  return values.map(value => {
    const person = normalizePerson(value, tenantInput, { requireId: true });
    const user = person.serviceNowUserName.toLowerCase();
    if (emails.has(person.email) || users.has(user) || ids.has(person.id)) throw invalid('That email or ServiceNow user ID is already in this config. Edit the existing plan instead of duplicating it.', 'duplicate_person');
    emails.add(person.email); users.add(user); ids.add(person.id); return person;
  });
}
module.exports = { normalizePerson, validatePeople };
