'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  throw Object.assign(new Error('Operation data must be finite JSON.'), { code: 'invalid_input', status: 400 });
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function frozen(value) {
  const copy = JSON.parse(canonical(value));
  const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(copy);
}
function busy() { return Object.assign(new Error('An operation owns this physical PDI. Wait for completion. A stopped controller lock requires explicit local recovery; synced history is not a lock.'), { code: 'pdi_busy', status: 409 }); }
class ExecutionLocks {
  constructor(runtimeHome) { this.directory = path.join(runtimeHome, 'state', 'pdi-locks'); this.leases = new Map(); }
  file(pdiUrl) { return path.join(this.directory, createHash('sha256').update(new URL(pdiUrl).hostname).digest('hex') + '.lock'); }
  async assertIdle(pdiUrl, lease) {
    if (lease && this.leases.get(lease)?.file === this.file(pdiUrl)) return;
    try { await fs.lstat(this.file(pdiUrl)); throw busy(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async acquire(pdiUrl, context) {
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.file(pdiUrl), lease = Object.freeze({ id: randomUUID() });
    let handle;
    try { handle = await fs.open(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw busy(); throw e; }
    try { await handle.writeFile(canonical({ pid: process.pid, leaseId: lease.id, startedAt: new Date().toISOString(), context })); await handle.sync(); }
    catch (e) { await handle.close(); await fs.unlink(file); throw e; }
    this.leases.set(lease, { file, handle });
    return lease;
  }
  async release(lease) {
    const owned = this.leases.get(lease);
    if (!owned) throw busy();
    try { await owned.handle.close(); await fs.unlink(owned.file); } finally { this.leases.delete(lease); }
  }
}
module.exports = { canonical, digest, frozen, ExecutionLocks };
