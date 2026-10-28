const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('automatic execution preserves gates, pause/stop, target queues and restart checkpoints', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-automatic-'));
  process.env.ORBIT_STORE_PATH = path.join(dir, 'store.json');
  process.env.ORBIT_STEP_INTERVAL_MS = '80';
  let server = require('../server');
  const listen = async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; };
  let base = await listen();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(url, body, method = 'POST') {
    const r = await fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await r.json(); assert.ok(r.ok, data.error); return data;
  }
  const state = await request('/api/state', undefined, 'GET');
  await request('/api/organizations/ee-orchestration/approvers', { approvers: [state.currentUser.name] }, 'PATCH');
  const create = agentId => request('/api/runs', { organizationId: 'ee-orchestration', agentId });
  const get = run => request('/api/runs/' + run.id + '?organizationId=ee-orchestration', undefined, 'GET');
  const action = (run, name, extra = {}) => request('/api/runs/' + run.id + '/' + name, { organizationId: run.organizationId, revision: run.revision, planHash: run.planHash, ...extra });
  async function wait(run, predicate) {
    for (let i = 0; i < 150; i++) { const latest = await get(run); if (predicate(latest)) return latest; await delay(30); }
    assert.fail('Automatic workflow did not reach expected checkpoint');
  }
  const notification = await create('notification'); assert.equal(notification.autoRun, true);
  const completed = await wait(notification, r => r.status === 'completed'); assert.equal(completed.receipts.length, 2);
  let incident = await create('incident-triage'); incident = await wait(incident, r => r.status === 'awaiting_approval');
  assert.equal(incident.cursor, 4); await delay(250); assert.equal((await get(incident)).cursor, 4);
  incident = await action(incident, 'pause'); const pausedCursor = incident.cursor;
  await new Promise(resolve => server.close(resolve));
  delete require.cache[require.resolve('../server')]; server = require('../server'); base = await listen();
  await delay(250); incident = await get(incident); assert.equal(incident.status, 'paused'); assert.equal(incident.cursor, pausedCursor);
  let queued = await create('oke-vulnerabilities'); queued = await wait(queued, r => r.waitingForTarget === true); assert.equal(queued.cursor, 0);
  incident = await action(incident, 'resume'); assert.equal(incident.status, 'awaiting_approval');
  incident = await action(incident, 'approve'); incident = await wait(incident, r => r.status === 'awaiting_customer');
  const customerCursor = incident.cursor; await delay(250); assert.equal((await get(incident)).cursor, customerCursor);
  incident = await action(incident, 'validate', { confirmed: true, evidence: 'Customer explicitly confirmed simulated recovery' });
  await wait(incident, r => r.status === 'completed');
  queued = await wait(queued, r => r.status === 'awaiting_approval'); assert.equal(queued.waitingForTarget, undefined);
  queued = await action(queued, 'stop'); await delay(250); assert.equal((await get(queued)).status, 'stopped');
  // Scope violations halt automation, retain checkpoint and do not retry silently.
  let blocked = await create('apex-troubleshooting');
  await new Promise(resolve => server.close(resolve));
  const store = JSON.parse(fs.readFileSync(process.env.ORBIT_STORE_PATH));
  store.organizations.find(o => o.id === 'ee-orchestration').agentTarget.namespace = 'changed-scope';
  fs.writeFileSync(process.env.ORBIT_STORE_PATH, JSON.stringify(store));
  delete require.cache[require.resolve('../server')]; server = require('../server'); base = await listen();
  blocked = await wait(blocked, r => r.status === 'blocked'); assert.match(blocked.error, /scope changed/);
  const revision = blocked.revision; await delay(250); assert.equal((await get(blocked)).revision, revision);
});
