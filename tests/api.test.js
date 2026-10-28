const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('API integrates governed requests, approval, persistence and private asset boundaries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));
  process.env.ORBIT_STORE_PATH = path.join(dir, 'store.json');
  process.env.ORBIT_STEP_INTERVAL_MS = '60000';
  const server = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function api(url, method = 'GET', body) { const r = await fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; }
  const state = (await api('/api/state')).body;
  assert.equal(state.agents.filter(a => a.runtime).length, 10);
  const task = await api('/api/tasks', 'POST', { organizationId: 'ee-orchestration', title: 'Upgrade cluster nodepool', risk: 'low' });
  assert.equal(task.status, 201); assert.equal(task.body.agentId, 'cluster-nodepool-upgrade'); assert.equal(task.body.risk, 'high'); assert.ok(task.body.runId);
  const id = task.body.runId;
  let run = (await api('/api/runs/' + id + '?organizationId=ee-orchestration')).body;
  assert.equal((await api('/api/runs/' + id + '?organizationId=computer-ops')).status, 404);
  async function action(name, extra = {}) { const r = await api('/api/runs/' + id + '/' + name, 'POST', { organizationId: run.organizationId, revision: run.revision, planHash: run.planHash, ...extra }); if (r.status === 200) run = r.body; return r; }
  await action('advance'); await action('advance'); await action('advance'); assert.equal(run.status, 'awaiting_approval');
  assert.equal((await action('approve')).status, 403);
  await api('/api/organizations/ee-orchestration/approvers', 'PATCH', { approvers: [state.currentUser.name] });
  assert.equal((await action('approve')).status, 200);
  assert.equal((await action('advance', { revision: 0 })).status, 409);
  await action('advance'); await action('advance'); assert.equal(run.status, 'completed');
  const persisted = JSON.parse(fs.readFileSync(process.env.ORBIT_STORE_PATH));
  assert.equal(persisted.tasks.find(t => t.runId === id).status, 'completed');
  assert.equal(persisted.runs.find(r => r.id === id).receipts.length, 5);
  assert.ok(persisted.audit.some(e => e.runId === id));
  for (const resource of ['/data/store.json', '/server.js', '/agent-runtime.js', '/.git/config', '/api/unknown']) assert.equal((await api(resource)).status, 404);
  assert.equal((await fetch(base + '/workflows.html')).status, 200);
  const unavailable = await api('/api/tasks', 'POST', { organizationId: 'ee-orchestration', title: 'test', preferredAgentId: 'missing' }); assert.equal(unavailable.status, 403);
});
