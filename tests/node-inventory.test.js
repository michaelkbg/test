const test = require('node:test');
const assert = require('node:assert/strict');
const inventory = require('../node-inventory');
const runtime = require('../agent-runtime');
const actor = { name: 'Approver' };
function fixture() {
  const state = { organizations: [{ id: 'a', name: 'Team A', approvers: [actor.name] }, { id: 'b', name: 'Team B', approvers: [actor.name] }], agents: Object.keys(runtime.definitions).map(id => ({ id, name: id, scope: 'shared' })) };
  runtime.initialize(state); return state;
}
const create = (state, scopeId = 'default') => runtime.createRun(state, { organizationId: 'a', agentId: 'oke-vulnerabilities', inventoryScopeId: scopeId, input: { ...runtime.definitions['oke-vulnerabilities'].input, inventoryScopeId: scopeId } }, actor).run;
const act = (state, run, action = 'advance') => runtime.act(state, run, action, { revision: run.revision, planHash: run.planHash }, actor);
test('all compartment nodes are persisted and planned from discovery, without ten-node truncation', () => {
  const state = fixture(), scope = inventory.scopeFor(state, 'a');
  scope.demoNodes = Array.from({ length: 15 }, (_, i) => ({ id: 'node-' + (i + 1), name: 'Node ' + (i + 1), lifecycleState: 'RUNNING' }));
  scope.demoNodes.push({ id: 'stopped-node', lifecycleState: 'STOPPED' });
  const run = create(state); assert.equal(run.plan.input.nodes.length, 15); assert.equal(run.plan.inventory.allNodeCount, 16);
  assert.equal(state.nodeInventories[0].nodes.length, 16); assert.equal(state.nodeInventories[0].eligibleNodeIds.length, 15);
  assert.equal(state.nodeInventories[0].compartmentId, scope.compartmentId);
  const saved = JSON.parse(JSON.stringify(state)); runtime.initialize(saved); assert.equal(saved.nodeInventories[0].nodes.length, 16);
  assert.equal(create(state).id, run.id);
});
test('updated node list is fetched before preflight and again before package patch', () => {
  const state = fixture(), run = create(state); act(state, run); act(state, run); act(state, run, 'approve');
  const plannedFetch = run.plan.inventory.fetchId;
  act(state, run); const preflightFetch = run.latestInventory.fetchId; assert.notEqual(preflightFetch, plannedFetch);
  act(state, run); const drainFetch = run.latestInventory.fetchId;
  act(state, run); assert.notEqual(run.latestInventory.fetchId, drainFetch);
  assert.ok(run.receipts.find(r => r.name.startsWith('Patch')).output.inventoryCheck);
});
test('added, removed or non-running nodes halt the approved plan before patching', () => {
  for (const kind of ['added', 'removed', 'stopped']) {
    const state = fixture(), scope = inventory.scopeFor(state, 'a'), run = create(state);
    act(state, run); act(state, run); act(state, run, 'approve'); act(state, run); act(state, run);
    if (kind === 'added') scope.demoNodes.push({ id: 'node-new', lifecycleState: 'RUNNING' });
    if (kind === 'removed') scope.demoNodes.shift();
    if (kind === 'stopped') scope.demoNodes[0].lifecycleState = 'STOPPED';
    const cursor = run.cursor; assert.throws(() => act(state, run), /inventory changed/); assert.equal(run.cursor, cursor);
    assert.ok(!run.receipts.some(r => r.name.startsWith('Patch')));
    assert.notEqual(state.nodeInventories[0].inventoryHash, run.plan.inventory.inventoryHash);
  }
});
test('inventory scopes are isolated by team, tenancy, compartment and region', () => {
  const state = fixture(), org = state.organizations[0];
  const scope = inventory.configure(state, org, { name: 'Second tenancy', tenancyId: 'demo-2', compartmentId: 'compartment-2', region: 'region-2', adapter: 'simulation', demoNodes: ['node-other'] });
  create(state); const other = create(state, scope.id); assert.deepEqual(other.plan.input.nodes, ['node-other']);
  assert.equal(state.nodeInventories.length, 2); assert.throws(() => inventory.scopeFor(state, 'b', scope.id), /not found/);
  scope.compartmentId = 'rebound'; assert.throws(() => act(state, other), /binding changed/);
});
test('OCI adapter verifies compartment ancestry and reads every instance page with --all', async () => {
  const scope = { id: 'live', organizationId: 'a', adapter: 'oci-cli', tenancyId: 'ocid1.tenancy.oc1..tenancy', compartmentId: 'ocid1.compartment.oc1..leaf', region: 'us-ashburn-1', profileName: 'TEAM_A', authMode: 'security_token' };
  const calls = [];
  const rows = await inventory.discoverOCI(scope, async args => {
    calls.push(args);
    if (args[0] === 'iam') return { data: { id: args[args.indexOf('--compartment-id') + 1], 'compartment-id': args.includes('ocid1.compartment.oc1..leaf') ? 'ocid1.compartment.oc1..parent' : scope.tenancyId } };
    return { data: [{ id: 'ocid1.instance.oc1..node', 'compartment-id': scope.compartmentId, 'lifecycle-state': 'RUNNING' }] };
  });
  assert.equal(rows.length, 1); assert.equal(calls.length, 3); assert.ok(calls.at(-1).includes('--all')); assert.ok(calls.every(c => c.includes('TEAM_A') && c.includes('us-ashburn-1') && c.includes('security_token')));
  await assert.rejects(inventory.discoverOCI(scope, async () => ({ data: { id: scope.compartmentId, 'compartment-id': 'ocid1.tenancy.oc1..other' } })), /does not belong/);
});
test('partial or failed discovery never authorizes stale inventory', async () => {
  const state = fixture(), scope = inventory.scopeFor(state, 'a'); inventory.refreshSimulation(state, scope);
  scope.adapter = 'oci-cli'; scope.profileName = 'TEAM_A'; scope.tenancyId = 'ocid1.tenancy.oc1..tenancy'; scope.compartmentId = 'ocid1.compartment.oc1..compartment';
  // Save a good snapshot, then verify that a provider error flags it without replacing its nodes.
  await inventory.refresh(state, scope, async args => args[0] === 'iam' ? { data: { id: scope.compartmentId, 'compartment-id': scope.tenancyId } } : { data: [{ id: 'node-live', 'compartment-id': scope.compartmentId, 'lifecycle-state': 'RUNNING' }] });
  const before = state.nodeInventories.find(s => s.scopeId === scope.id && s.compartmentId === scope.compartmentId);
  await assert.rejects(inventory.refresh(state, scope, async () => { throw Error('Provider unavailable'); }), /unavailable/);
  assert.equal(before.nodes[0].id, 'node-live'); assert.equal(before.lastRefreshError, 'Provider unavailable');
  assert.throws(() => inventory.snapshotForPlan(state, state.organizations[0], scope.id, { fetchId: before.fetchId }), /successful fresh/);
  await assert.rejects(inventory.discoverOCI(scope, async args => args[0] === 'iam' ? { data: { id: scope.compartmentId, 'compartment-id': scope.tenancyId } } : { data: [], 'opc-next-page': 'partial' }), /incomplete/);
});
