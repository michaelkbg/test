const { randomUUID, createHash } = require('crypto');
const { routeTicket } = require('./jira-intake');
const inventory = require('./node-inventory');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const step = (name, tool, gate) => ({ name, tool, ...(gate ? { gate } : {}) });
const definitions = {
  'oke-vulnerabilities': { kind: 'vulnerability', description: 'Discover all compartment nodes, save inventory, and re-fetch before serial remediation with approval and recovery gates.', tools: ['inventory', 'scanner', 'kubernetes', 'package-manager', 'health'], input: { inventoryScopeId: 'default', nodes: [], cve: 'CVE-DEMO-001', package: 'openssl', fixedVersion: 'vendor-fixed-demo' } },
  'apex-vulnerabilities': { kind: 'application-security', description: 'Assess application findings and propose a reviewed source remediation.', tools: ['scanner', 'knowledge', 'github', 'deployment', 'health'], input: { finding: 'Dependency vulnerability in APEX application' } },
  'oke-cluster-provisioning': { kind: 'provision', description: 'Plan an OKE cluster, review the source change and verify a simulated deployment.', tools: ['inventory', 'github', 'deployment', 'health'], input: { clusterName: 'demo-cluster' } },
  'cluster-nodepool-upgrade': { kind: 'upgrade', description: 'Preview a nodepool upgrade, review the source and validate a canary rollout.', tools: ['inventory', 'github', 'deployment', 'health'], input: { version: 'demo-next-version' } },
  'ticket-management': { kind: 'ticket', readOnly: true, description: 'Classify a ticket and prepare a response and owner recommendation.', tools: ['jira', 'knowledge'], input: { ticket: 'OPS-101', summary: 'Service request: inspect application availability', description: 'No additional description supplied', requestType: 'auto' } },
  'tpls-management': { kind: 'tls', description: 'Create or renew a team certificate candidate, review its binding and promote only after verification.', tools: ['cmc', 'certificate-validator', 'github', 'deployment', 'health'], input: { hostname: 'app.example.test', bindingId: 'app', operation: 'create', secretName: 'tls-demo' } },
  notification: { kind: 'notification', readOnly: true, description: 'Prepare a tenant-scoped notification and record its simulated outbox receipt.', tools: ['notification'], input: { channel: 'team-operations', message: 'Governed workflow status update' } },
  'apex-troubleshooting': { kind: 'diagnosis', readOnly: true, description: 'Read-only application diagnosis with evidence and a proposed recovery plan.', tools: ['metrics', 'knowledge'], input: { symptom: 'Application latency increased' } },
  'oke-troubleshooting': { kind: 'diagnosis', readOnly: true, description: 'Read-only cluster diagnosis with scoped evidence and a proposed recovery plan.', tools: ['metrics', 'knowledge'], input: { symptom: 'Pods are pending in the team namespace' } },
  'incident-triage': { kind: 'incident', description: 'Durable ticket triage, read-only diagnosis, reviewed change, recovery and explicit customer validation.', tools: ['jira', 'knowledge', 'metrics', 'github', 'deployment', 'health'], input: { ticket: 'INC-101', summary: 'Ingress returns HTTP 503', sourcePath: 'deploy/values.yaml' } }
};
function fail(message, code = 400) { const error = new Error(message); error.statusCode = code; throw error; }
function text(value, name) { if (typeof value !== 'string' || !value.trim() || value.length > 1000) fail(name + ' must be a nonempty string of at most 1000 characters.'); return value.trim(); }
function targetFor(org) { return { tenancy: 'demo-' + org.id, region: 'demo-region', cluster: 'demo-cluster', namespace: org.id, repository: 'demo/' + org.id, sourcePaths: ['deploy/values.yaml', 'certificates/public.pem'], allowedNodes: ['node-1', 'node-2', 'node-3'], allowedTools: [...new Set(Object.values(definitions).flatMap(d => d.tools))] }; }
function initialize(state) {
  state.runs ||= []; state.certificateBindings ||= []; state.resourceLocks ||= {};
  state.organizations.forEach(org => { org.agentTarget ||= targetFor(org); });
  inventory.initialize(state);
  state.agents.forEach(agent => { const d = definitions[agent.id]; if (d) Object.assign(agent, { runtime: 'simulation', success: 'Simulation', workflow: d.kind, purpose: d.description, allowedTools: d.tools }); });
}
function available(state, organizationId, agentId) {
  const org = state.organizations.find(o => o.id === organizationId);
  const agent = state.agents.find(a => a.id === agentId && (a.scope === 'shared' || (a.scope === 'team' && a.organizationId === organizationId)));
  if (!org) fail('Team not found.', 404);
  if (!agent) fail('Agent is not available to this team.', 403);
  if (!definitions[agent.id]) fail('This dedicated agent has configuration only; no runtime adapter is registered.', 409);
  return { org, agent, definition: definitions[agent.id] };
}
function buildSteps(d, input) {
  switch (d.kind) {
    case 'vulnerability': return [step('Bind finding and vendor inventory', 'scanner'), step('Approve immutable serial remediation plan', 'inventory', 'approval'), ...input.nodes.flatMap((node, i) => [step((i ? 'Next node' : 'Canary') + ' preflight: ' + node, 'health'), step('Drain workloads: ' + node, 'kubernetes'), step('Patch signed packages: ' + node, 'package-manager'), step('Controlled reboot: ' + node, 'package-manager'), step('Validate recovery: ' + node, 'health'), step('Restore service: ' + node, 'kubernetes'), step('Observe stability: ' + node, 'health')].map(s => ({ ...s, node }))), step('Fresh vendor-aware rescan', 'scanner')];
    case 'incident': return [step('Triage ticket and resolve target', 'jira'), step('Retrieve applicable runbook', 'knowledge'), step('Read-only diagnosis and recovery plan', 'metrics'), step('Prepare source change proposal', 'github'), step('Human approval and required checks', 'github', 'approval'), step('Deploy approved merged source', 'deployment'), step('Verify technical recovery', 'health'), step('Await customer validation', 'jira', 'customer'), step('Record RCA and resolve ticket', 'jira')];
    case 'tls': return [step('Validate and save team binding', 'cmc'), step('Create or renew certificate candidate', 'cmc'), step('Validate candidate SAN, chain and key reference', 'certificate-validator'), step('Prepare public certificate and ingress proposal', 'github'), step('Human approval and required checks', 'github', 'approval'), step('Deploy approved TLS binding', 'deployment'), step('Verify served TLS and application', 'health'), step('Promote active certificate and schedule renewal', 'certificate-validator')];
    case 'diagnosis': return [step('Collect scoped operational evidence', 'metrics'), step('Match approved runbook', 'knowledge'), step('Return diagnosis and recovery recommendation', 'knowledge')];
    case 'ticket': return [step('Read and classify ticket', 'jira'), step('Resolve owner and applicable knowledge', 'knowledge'), step('Prepare customer response', 'jira')];
    case 'notification': return [step('Prepare tenant-scoped message', 'notification'), step('Record simulated notification outbox receipt', 'notification')];
    default: return [step('Collect inventory and assess request', d.tools[0]), step('Build immutable source change proposal', 'github'), step('Human approval and required checks', 'github', 'approval'), step(d.kind === 'upgrade' ? 'Canary upgrade from approved source' : 'Deploy approved source', 'deployment'), step('Verify recovery and desired state', 'health')];
  }
}
function createRun(state, body, actor) {
  const { org, agent, definition: d } = available(state, body.organizationId, body.agentId);
  const input = body.input === undefined ? structuredClone(d.input) : structuredClone(body.input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Workflow input must be an object.');
  const allowed = new Set(Object.keys(d.input));
  if (Object.keys(input).some(key => !allowed.has(key))) fail('Input contains unsupported fields. Use credential references in team configuration, never secret material.');
  if (d.kind === 'vulnerability') input.inventoryScopeId ||= body.inventoryScopeId || 'default';
  for (const key of Object.keys(d.input)) if (key !== 'nodes') input[key] = text(input[key], key);
  let discovered;
  if (d.kind === 'vulnerability') {
    discovered = inventory.snapshotForPlan(state, org, input.inventoryScopeId, body.inventorySnapshot);
    if (input.nodes !== undefined && (!Array.isArray(input.nodes) || input.nodes.some(n => !discovered.nodeIds.includes(n)))) fail('A node is outside this team’s discovered compartment inventory.', 403);
    input.nodes = discovered.nodeIds;
  }
  const target = structuredClone(org.agentTarget);
  if (!target || !target.namespace || !target.repository || !Array.isArray(target.allowedTools) || !Array.isArray(target.sourcePaths)) fail('Team target configuration is incomplete.', 409);
  if (d.tools.some(tool => !target.allowedTools.includes(tool))) fail('A required tool is outside the team allowlist.', 403);
  if (d.kind === 'incident' && !target.sourcePaths.includes(input.sourcePath)) fail('Source path is outside this team’s configured paths.', 403);
  if (d.kind === 'tls') {
    if (!['create', 'renew'].includes(input.operation)) fail('Certificate operation must be create or renew.');
    if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(input.hostname) || !input.hostname.includes('.')) fail('Provide a DNS hostname.');
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(input.secretName) || input.secretName.length > 253) fail('Provide a valid Kubernetes Secret name.');
    if (!target.sourcePaths.includes('certificates/public.pem') || !target.sourcePaths.includes('deploy/values.yaml')) fail('Certificate and ingress source paths are not configured.', 403);
    const binding = state.certificateBindings.find(b => b.organizationId === org.id && b.bindingId === input.bindingId);
    if (input.operation === 'renew' && !binding) fail('Create and verify this binding before renewing.', 409);
    if (binding && (binding.secretName !== input.secretName || binding.hostname !== input.hostname)) fail('Renewal must reuse the saved hostname and Secret name.', 409);
    if (binding && input.operation === 'create') fail('This binding already exists. Use renew.', 409);
  }
  const plan = { ...(discovered ? { inventory: discovered } : {}), ...(body.requestKey ? { requestKey: text(body.requestKey, 'requestKey') } : {}), version: 1, runbook: 'mvp/' + agent.id + '@1', agentId: agent.id, organizationId: org.id, target, input, steps: buildSteps(d, input), mode: 'simulation' };
  const planHash = hash(plan);
  const comparable = p => hash(p.inventory ? { ...p, inventory: { ...p.inventory, fetchId: null, fetchedAt: null } } : p);
  const duplicate = state.runs.find(r => comparable(r.plan) === comparable(plan) && !['completed', 'stopped'].includes(r.status));
  if (duplicate) return { run: duplicate, created: false };
  const run = { id: 'RUN-' + randomUUID(), organizationId: org.id, agentId: agent.id, agentName: agent.name, title: body.title ? text(body.title, 'title') : agent.name, requester: actor.name, mode: 'simulation', plan, planHash, status: 'ready', cursor: 0, receipts: [], approvals: [], createdAt: new Date().toISOString(), revision: 0 };
  state.runs.unshift(run);
  return { run, created: true };
}
function scopedRun(state, id, organizationId) { const run = state.runs.find(r => r.id === id && r.organizationId === organizationId); if (!run) fail('Workflow not found in this team.', 404); return run; }
function resource(run) {
  // Shared cluster lock coordinates vulnerability maintenance with other deployments.
  const t = run.plan.target;
  return [run.organizationId, t.tenancy, t.region, t.cluster].join(':');
}
function resourceKeys(run) { const keys = [resource(run)]; if (run.plan.inventory) { const s = run.plan.inventory.scope; keys.push(JSON.stringify(['vulnerability', s.tenancyId, s.compartmentId, s.region])); } return keys; }
function authorize(state, run, actor) {
  const { org } = available(state, run.organizationId, run.agentId);
  if (hash(run.plan) !== run.planHash || hash(org.agentTarget) !== hash(run.plan.target)) fail('Plan or team scope changed. Stop and submit a new plan for renewed approval.', 409);
  if (run.plan.steps.some(s => !org.agentTarget.allowedTools.includes(s.tool))) fail('Tool no longer permitted.', 403);
  if (run.agentId === 'oke-vulnerabilities') inventory.assertScope(state, run);
  if (!actor || !actor.name) fail('Actor required.', 403);
  return org;
}
function receipt(run, current, output, outcome = 'passed') {
  run.receipts.push({ id: randomUUID(), step: run.cursor, name: current.name, tool: current.tool, node: current.node || null, outcome, mode: 'simulation', output, at: new Date().toISOString(), planHash: run.planHash });
}
function simulate(run, current) {
  const input = run.plan.input;
  const output = { simulated: true, target: run.plan.target.namespace, operationId: run.id + ':' + run.cursor, result: current.name + ' simulated successfully' };
  if (run.agentId === 'ticket-management') output.triage = { ticket: input.ticket, ...routeTicket(input), owner: run.organizationId + ' operations', suggestedResponse: 'We have received ' + input.ticket + ' and prepared an initial work routing recommendation.', mode: 'simulation' };
  if (current.tool === 'github') Object.assign(output, { proposal: 'simulation://' + run.id + '/source-proposal', sourcePaths: run.plan.target.sourcePaths, checks: 'simulated passing checks; no real PR or merge', mergedCommit: run.planHash });
  if (current.tool === 'deployment') Object.assign(output, { artifact: run.planHash, source: 'simulated approved merged source', externalChange: false });
  if (current.node) Object.assign(output, { node: current.node, availability: 'simulated healthy peers, capacity and quorum', ownership: run.id, inventoryCheck: run.latestInventory || null });
  if (current.name === 'Fresh vendor-aware rescan') output.finding = { cve: input.cve, fixedVersion: input.fixedVersion, status: 'simulated confirmed', nodes: input.nodes };
  if (current.tool === 'metrics') output.diagnosis = { cause: 'Illustrative hypothesis from simulated telemetry', confidence: 'unknown', evidence: ['Simulated metrics and events'], recommendation: 'Review the applicable team runbook and source proposal' };
  if (current.tool === 'cmc') output.cmcRequestId = 'simulated-' + run.id;
  if (current.name === 'Validate candidate SAN, chain and key reference') {
    run.candidate = { fingerprint: hash({ id: run.id, hostname: input.hostname }), hostname: input.hostname, notAfter: new Date(Date.now() + 90 * 86400000).toISOString(), keyVersionRef: 'simulation-vault://' + run.organizationId + '/' + input.bindingId + '/' + run.id, validation: 'simulated SAN/chain/key checks' };
    output.candidate = run.candidate;
  }
  return output;
}
function act(state, run, action, body, actor) {
  if (!Number.isInteger(body.revision) || body.revision !== run.revision) fail('Workflow changed. Refresh before acting.', 409);
  if (['completed', 'stopped'].includes(run.status)) fail('Workflow is already terminal.', 409);
  const org = action === 'stop' ? state.organizations.find(o => o.id === run.organizationId) : authorize(state, run, actor);
  const current = run.plan.steps[run.cursor];
  if (action === 'start') { if (run.status !== 'ready') fail('Only ready workflows can start.', 409); run.autoRun = true; }
  else if (action === 'pause') { if (['paused', 'blocked'].includes(run.status)) fail('Workflow is already paused or blocked.', 409); run.resumeStatus = run.status; run.status = 'paused'; }
  else if (action === 'stop') { run.status = 'stopped'; run.stoppedAt = new Date().toISOString(); for (const key of resourceKeys(run)) if (state.resourceLocks[key] === run.id) delete state.resourceLocks[key]; }
  else if (action === 'failure') {
    if (run.status !== 'paused' || run.resumeStatus !== 'ready' || current.gate) fail('Pause a runnable step before simulating a failure.', 409);
    receipt(run, current, { result: 'Injected simulation failure; reconcile before retrying' }, 'failed');
    run.error = current.name + ' failed in simulation'; run.status = 'blocked'; run.resumeStatus = 'ready';
  }
  else if (action === 'resume') { if (!['paused', 'blocked'].includes(run.status)) fail('Only paused or blocked workflows can resume.', 409); run.status = run.resumeStatus || 'ready'; delete run.error; }
  else if (action === 'approve') {
    if (run.status !== 'awaiting_approval' || current.gate !== 'approval') fail('This step is not awaiting approval.', 409);
    if (!(org.approvers || []).some(a => a.toLowerCase() === actor.name.toLowerCase())) fail('Only a designated team approver can approve this plan.', 403);
    if (body.planHash !== run.planHash) fail('Approval must reference the exact plan hash.', 409);
    run.approvals.push({ actor: actor.name, planHash: run.planHash, step: run.cursor, at: new Date().toISOString() });
    receipt(run, current, { approvedBy: actor.name, checks: 'simulation', mergedCommit: run.planHash }); run.cursor++; run.status = 'ready';
  } else if (action === 'validate') {
    if (run.status !== 'awaiting_customer' || current.gate !== 'customer') fail('This workflow is not awaiting customer validation.', 409);
    if (body.confirmed !== true) fail('Explicit customer confirmation is required.');
    receipt(run, current, { confirmed: true, actor: actor.name, evidence: text(body.evidence, 'Customer validation evidence') }); run.cursor++; run.status = 'ready';
  } else if (action === 'advance') {
    if (run.status !== 'ready') fail('Workflow must be ready before advancing.', 409);
    if (current.gate) { run.status = current.gate === 'customer' ? 'awaiting_customer' : 'awaiting_approval'; }
    else {
      const lockKey = resource(run), lockKeys = resourceKeys(run), needsLock = !definitions[run.agentId].readOnly, owner = needsLock && lockKeys.map(key => state.resourceLocks[key]).find(id => id && id !== run.id);
      if (owner && owner !== run.id) { const error = new Error('Another workflow owns this target. Waiting for it to finish or stop.'); error.statusCode = 409; error.code = 'TARGET_BUSY'; throw error; }
      if (current.tool === 'deployment' || current.node) {
        if (!run.approvals.some(a => a.planHash === run.planHash)) fail('Exact plan approval is required before mutation.', 403);
      }
      if (inventory.needsRefresh(run)) {
        const scope = inventory.scopeFor(state, run.organizationId, run.plan.inventory.scope.id);
        if (scope.adapter === 'simulation') {
          const snapshot = inventory.refreshSimulation(state, scope);
          run.latestInventory = { fetchId: snapshot.fetchId, fetchedAt: snapshot.fetchedAt, inventoryHash: snapshot.inventoryHash, step: run.cursor };
        }
        inventory.assertFresh(state, run);
      }
      if (needsLock) for (const key of lockKeys) state.resourceLocks[key] = run.id;
      if (body.outcome === 'fail') { receipt(run, current, { result: 'Injected simulation failure; reconcile before retrying; target lock retained' }, 'failed'); run.error = current.name + ' failed in simulation'; run.status = 'blocked'; run.resumeStatus = 'ready'; }
      else {
        receipt(run, current, simulate(run, current)); run.cursor++;
        if (run.cursor === run.plan.steps.length) {
          if (run.plan.agentId === 'tpls-management') {
            const i = run.plan.input, binding = { organizationId: run.organizationId, bindingId: i.bindingId, hostname: i.hostname, secretName: i.secretName, target: run.plan.target, active: run.candidate, nextRenewalAt: new Date(new Date(run.candidate.notAfter).getTime() - 30 * 86400000).toISOString(), lastRunId: run.id, mode: 'simulation' };
            const index = state.certificateBindings.findIndex(b => b.organizationId === run.organizationId && b.bindingId === i.bindingId);
            if (index >= 0) state.certificateBindings[index] = binding; else state.certificateBindings.push(binding);
          }
          run.status = 'completed'; run.completedAt = new Date().toISOString(); for (const key of lockKeys) if (state.resourceLocks[key] === run.id) delete state.resourceLocks[key];
        }
      }
    }
  } else fail('Unknown workflow action.', 404);
  run.revision++; run.updatedAt = new Date().toISOString();
  return run;
}
function scheduleDueRenewals(state, now = Date.now()) {
  const scheduled = [], blocked = [];
  for (const binding of state.certificateBindings) {
    if (binding.mode !== 'simulation' || new Date(binding.nextRenewalAt).getTime() > now || binding.lastScheduledFingerprint === binding.active.fingerprint) continue;
    if (state.runs.some(r => r.organizationId === binding.organizationId && r.plan.agentId === 'tpls-management' && r.plan.input.bindingId === binding.bindingId && !['completed', 'stopped'].includes(r.status))) continue;
    try {
      const org = state.organizations.find(o => o.id === binding.organizationId);
      if (!org || hash(org.agentTarget) !== hash(binding.target)) fail('Saved certificate target no longer matches team configuration.', 409);
      const { run } = createRun(state, { organizationId: binding.organizationId, agentId: 'tpls-management', input: { hostname: binding.hostname, bindingId: binding.bindingId, operation: 'renew', secretName: binding.secretName } }, { name: 'Renewal scheduler' });
      binding.lastScheduledFingerprint = binding.active.fingerprint; delete binding.schedulingError; scheduled.push(run);
    } catch (error) { if (binding.schedulingError !== error.message) { binding.schedulingError = error.message; blocked.push({ organizationId: binding.organizationId, bindingId: binding.bindingId, error: error.message }); } }
  }
  return { scheduled, blocked };
}
module.exports = { definitions, initialize, createRun, scopedRun, act, targetFor, scheduleDueRenewals };
