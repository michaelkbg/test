const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../agent-runtime');
const actor = { name: 'Demo Approver' };
function fixture() {
  const state = { organizations: [{ id: 'a', name: 'Team A', approvers: [actor.name] }, { id: 'b', name: 'Team B', approvers: [actor.name] }], agents: Object.keys(runtime.definitions).map(id => ({ id, name: id, scope: 'shared' })) };
  runtime.initialize(state); return state;
}
function create(state, id, input, organizationId = 'a') { return runtime.createRun(state, { organizationId, agentId: id, ...(input ? { input } : {}) }, actor).run; }
function act(state, run, action, body = {}, user = actor) { return runtime.act(state, run, action, { revision: run.revision, planHash: run.planHash, ...body }, user); }
function finish(state, run) {
  while (run.status !== 'completed') act(state, run, run.status === 'awaiting_approval' ? 'approve' : run.status === 'awaiting_customer' ? 'validate' : 'advance', { confirmed: true, evidence: 'Customer explicitly confirmed recovery in simulation' });
}
for (const id of Object.keys(runtime.definitions)) test(id + ' completes with simulated step evidence', () => {
  const state = fixture(), run = create(state, id); finish(state, run);
  assert.equal(run.cursor, run.plan.steps.length); assert.equal(run.receipts.length, run.plan.steps.length);
  assert.ok(run.receipts.every(r => r.mode === 'simulation' && r.planHash === run.planHash)); assert.deepEqual(state.resourceLocks, {});
  if (!runtime.definitions[id].readOnly) assert.equal(run.approvals.length, 1);
});
test('vulnerability remediation is canary-first and serial; failed health gate prevents next node', () => {
  const state = fixture(), run = create(state, 'oke-vulnerabilities');
  act(state, run, 'advance'); act(state, run, 'advance'); act(state, run, 'approve');
  while (!run.plan.steps[run.cursor].name.startsWith('Observe stability')) act(state, run, 'advance');
  act(state, run, 'advance', { outcome: 'fail' });
  assert.equal(run.status, 'blocked'); assert.ok(!run.receipts.some(r => r.node === 'node-2'));
  assert.throws(() => act(state, run, 'advance'), /ready/);
  act(state, run, 'resume'); finish(state, run);
  const nodes = run.receipts.filter(r => r.node).map(r => r.node);
  assert.ok(nodes.slice(0, nodes.indexOf('node-2')).every(n => n === 'node-1'));
});
test('exact plan, designated approver and revision are enforced', () => {
  const state = fixture(), run = create(state, 'oke-vulnerabilities');
  assert.throws(() => act(state, run, 'approve'), /not awaiting/);
  act(state, run, 'advance'); act(state, run, 'advance');
  assert.throws(() => act(state, run, 'approve', {}, { name: 'Untrusted' }), /designated/);
  assert.throws(() => act(state, run, 'approve', { planHash: 'wrong' }), /exact plan/);
  assert.throws(() => act(state, run, 'approve', { revision: 0 }), /changed/);
  assert.equal(run.approvals.length, 0); act(state, run, 'approve');
});
test('no agent invocation across tenant ownership or after unsharing', () => {
  const state = fixture(); state.agents[0].scope = 'team'; state.agents[0].organizationId = 'a';
  assert.throws(() => create(state, state.agents[0].id, undefined, 'b'), /not available/);
  const run = create(state, state.agents[0].id); state.agents[0].scope = 'unshared';
  assert.throws(() => act(state, run, 'advance'), /not available/); act(state, run, 'stop');
  assert.throws(() => runtime.scopedRun(state, run.id, 'b'), /not found/);
});
test('tool allowlist and source scope are checked before planning', () => {
  const state = fixture(); state.organizations[0].agentTarget.allowedTools = ['jira'];
  assert.throws(() => create(state, 'incident-triage'), /allowlist/);
  const other = fixture(); assert.throws(() => create(other, 'incident-triage', { ...runtime.definitions['incident-triage'].input, sourcePath: '../other-team/config' }), /outside/);
});
test('plan and target drift block execution; stopping remains possible', () => {
  for (const changePlan of [true, false]) {
    const state = fixture(), run = create(state, 'oke-vulnerabilities');
    if (changePlan) run.plan.input.fixedVersion = 'tampered'; else state.organizations[0].agentTarget.namespace = 'other';
    assert.throws(() => act(state, run, 'advance'), /changed/); act(state, run, 'stop');
  }
});
test('target locks survive restart, block overlapping workflows and allow other teams and diagnostics', () => {
  let state = fixture(), first = create(state, 'oke-vulnerabilities'); act(state, first, 'advance');
  state = JSON.parse(JSON.stringify(state)); runtime.initialize(state); first = state.runs[0];
  const second = create(state, 'incident-triage'); assert.throws(() => act(state, second, 'advance'), /owns/);
  finish(state, create(state, 'oke-troubleshooting'));
  assert.ok(Object.values(state.resourceLocks).includes(first.id));
  const other = create(state, 'incident-triage', undefined, 'b'); act(state, other, 'advance');
  act(state, first, 'stop'); act(state, second, 'advance');
});
test('pause resumes the checkpoint and no implicit customer confirmation closes incident', () => {
  const state = fixture(), run = create(state, 'incident-triage');
  while (run.status !== 'awaiting_customer') act(state, run, run.status === 'awaiting_approval' ? 'approve' : 'advance');
  const cursor = run.cursor; act(state, run, 'pause'); assert.throws(() => act(state, run, 'advance'), /ready/); act(state, run, 'resume');
  assert.equal(run.cursor, cursor); assert.equal(run.status, 'awaiting_customer');
  assert.throws(() => act(state, run, 'validate', { confirmed: false }), /Explicit/);
  assert.throws(() => act(state, run, 'validate', { confirmed: true, evidence: '' }), /evidence/);
  assert.equal(run.cursor, cursor); finish(state, run);
});
test('TLS promotes only verified candidate, reuses Secret on renew and computes expiry-based schedule', () => {
  const state = fixture(), initial = create(state, 'tpls-management'); finish(state, initial);
  const binding = state.certificateBindings[0], oldActive = structuredClone(binding.active);
  assert.equal(new Date(binding.active.notAfter) - new Date(binding.nextRenewalAt), 30 * 86400000);
  const input = { ...runtime.definitions['tpls-management'].input, operation: 'renew' };
  assert.throws(() => create(state, 'tpls-management', { ...input, secretName: 'different' }), /reuse/);
  const renewal = create(state, 'tpls-management', input);
  while (!renewal.plan.steps[renewal.cursor].name.startsWith('Verify served')) act(state, renewal, renewal.status === 'awaiting_approval' ? 'approve' : 'advance');
  assert.deepEqual(state.certificateBindings[0].active, oldActive);
  act(state, renewal, 'advance', { outcome: 'fail' }); assert.deepEqual(state.certificateBindings[0].active, oldActive);
  act(state, renewal, 'resume'); finish(state, renewal);
  assert.notEqual(state.certificateBindings[0].active.fingerprint, oldActive.fingerprint);
  assert.equal(state.certificateBindings[0].secretName, binding.secretName);
});
test('deduplication, terminal guards and unsupported secret fields', () => {
  const state = fixture(), run = create(state, 'notification'); assert.equal(create(state, 'notification').id, run.id);
  finish(state, run); assert.throws(() => act(state, run, 'advance'), /terminal/);
  assert.notEqual(create(state, 'notification').id, run.id);
  assert.throws(() => create(state, 'tpls-management', { ...runtime.definitions['tpls-management'].input, privateKey: 'secret' }), /unsupported/);
});

test('expiry scheduler queues one renewal with saved binding and requires fresh approval', () => {
  const state = fixture(), run = create(state, 'tpls-management'); finish(state, run);
  const binding = state.certificateBindings[0]; binding.nextRenewalAt = new Date(0).toISOString();
  const result = runtime.scheduleDueRenewals(state); assert.equal(result.scheduled.length, 1);
  const renewal = result.scheduled[0]; assert.equal(renewal.status, 'ready'); assert.equal(renewal.approvals.length, 0);
  assert.equal(renewal.plan.input.operation, 'renew'); assert.equal(renewal.plan.input.secretName, binding.secretName);
  assert.equal(runtime.scheduleDueRenewals(state).scheduled.length, 0);
  act(state, renewal, 'stop'); assert.equal(runtime.scheduleDueRenewals(state).scheduled.length, 0);
});
test('node inventory and renewal target drift fail closed', () => {
  const state = fixture(); assert.throws(() => create(state, 'oke-vulnerabilities', { ...runtime.definitions['oke-vulnerabilities'].input, nodes: ['unknown-node'] }), /inventory/);
  finish(state, create(state, 'tpls-management')); state.certificateBindings[0].nextRenewalAt = new Date(0).toISOString();
  state.organizations[0].agentTarget.namespace = 'other'; const result = runtime.scheduleDueRenewals(state);
  assert.equal(result.scheduled.length, 0); assert.equal(result.blocked.length, 1);
  assert.equal(runtime.scheduleDueRenewals(state).blocked.length, 0);
});
