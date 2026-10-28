const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
test('API saves scoped nodes, refreshes plans and blocks before a changed fleet is patched', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-inventory-api-'));
  process.env.ORBIT_STORE_PATH = path.join(dir, 'store.json'); process.env.ORBIT_STEP_INTERVAL_MS = '50';
  const server = require('../server'); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(url, body, method = 'POST') { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; }
  const endpoint = '/api/organizations/ee-orchestration/node-inventory';
  const catalogEndpoint = '/api/organizations/ee-orchestration/compartments';
  assert.equal((await request(catalogEndpoint, { name: 'oit-services-oke' })).status, 201);
  assert.equal((await request(catalogEndpoint, { name: 'oit-services-oke', compartmentId: 'invalid' })).status, 400);
  assert.equal((await request(catalogEndpoint, { name: 'oit-services-oke', compartmentId: 'ocid1.compartment.oc1..oke' })).status, 201);
  const catalogState = (await request('/api/state', undefined, 'GET')).body;
  const catalog = catalogState.organizations.find(o => o.id === 'ee-orchestration').availableCompartments;
  assert.equal(catalog.length, 1); assert.equal(catalog[0].id, 'ocid1.compartment.oc1..oke');
  assert.equal(catalogState.organizations.find(o => o.id === 'computer-ops').availableCompartments, undefined);
  assert.equal(JSON.parse(fs.readFileSync(process.env.ORBIT_STORE_PATH)).organizations.find(o => o.id === 'ee-orchestration').availableCompartments[0].name, 'oit-services-oke');
  const config = await request(endpoint, { name: 'Compartment A', tenancyId: 'tenancy-a', compartmentId: 'compartment-a', region: 'region-a', adapter: 'simulation', demoNodes: ['node-11', 'node-12', 'node-13'] }); assert.equal(config.status, 201);
  assert.equal((await request('/api/organizations/computer-ops/node-inventory/' + config.body.id + '/refresh')).status, 404);
  const snapshot = await request(endpoint + '/' + config.body.id + '/refresh'); assert.equal(snapshot.body.nodes.length, 3);
  await request('/api/organizations/ee-orchestration/approvers', { approvers: ['Michael Kabongo'] }, 'PATCH');
  const result = await request('/api/runs', { organizationId: 'ee-orchestration', agentId: 'oke-vulnerabilities', input: { inventoryScopeId: config.body.id, cve: 'CVE-TEST', package: 'openssl', fixedVersion: 'vendor-fixed' } }); assert.equal(result.status, 201);
  let run = result.body; assert.deepEqual(run.plan.input.nodes, ['node-11', 'node-12', 'node-13']);
  async function wait(predicate) { for (let i = 0; i < 100; i++) { run = (await request('/api/runs/' + run.id + '?organizationId=ee-orchestration', undefined, 'GET')).body; if (predicate(run)) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail('Inventory workflow did not reach expected state'); }
  await wait(r => r.status === 'awaiting_approval');
  await request(endpoint, { ...config.body, demoNodes: ['node-11', 'node-12', 'node-13', 'node-new'] });
  await request('/api/runs/' + run.id + '/approve', { organizationId: run.organizationId, revision: run.revision, planHash: run.planHash });
  await wait(r => r.status === 'blocked'); assert.match(run.error, /inventory changed/); assert.ok(!run.receipts.some(r => r.name.startsWith('Patch')));
  const saved = JSON.parse(fs.readFileSync(process.env.ORBIT_STORE_PATH));
  const latest = saved.nodeInventories.find(s => s.compartmentId === 'compartment-a'); assert.equal(latest.nodes.length, 4); assert.notEqual(latest.fetchId, snapshot.body.fetchId);
  assert.equal(saved.runs.find(r => r.id === run.id).status, 'blocked');
});
