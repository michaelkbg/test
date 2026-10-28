const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../agent-runtime');
const jira = require('../jira-intake');
function fixture() {
  const state = { organizations: [{ id: 'a', name: 'Team A', approvers: ['Lead'] }], agents: Object.keys(runtime.definitions).map(id => ({ id, name: id, scope: 'shared' })) };
  runtime.initialize(state); const org = state.organizations[0];
  jira.configure(state, org, { enabled: true, siteUrl: 'https://jira.example.test', projectKey: 'OPS', queueLabel: 'team-a' });
  return { state, org };
}
function event(key = 'OPS-1', summary = 'Application latency increased') { return { webhookEvent: 'jira:issue_created', issue: { id: '10001', key, self: 'https://jira.example.test/rest/api/2/issue/10001', fields: { project: { key: 'OPS' }, summary, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Customer is affected' }] }] }, labels: ['team-a'] } } }; }
test('new team Jira tickets create automatic triage plans and duplicates remain deduplicated after completion and restart', () => {
  let { state, org } = fixture(); const result = jira.ingest(state, org, event(), runtime);
  assert.equal(result.run.agentId, 'ticket-management'); assert.equal(result.run.autoRun, true); assert.equal(result.ticket.description, 'Customer is affected');
  while (result.run.status !== 'completed') runtime.act(state, result.run, 'advance', { revision: result.run.revision }, { name: 'Demo' });
  state = JSON.parse(JSON.stringify(state)); org = state.organizations[0];
  const duplicate = jira.ingest(state, org, event(), runtime); assert.equal(duplicate.created, false); assert.equal(state.runs.length, 1);
  const next = jira.ingest(state, org, event('OPS-2'), runtime); assert.equal(next.created, true); assert.notEqual(next.run.id, result.run.id);
});
test('queue, source, project and event filters prevent incorrect team intake', () => {
  const { state, org } = fixture();
  const updated = event(); updated.webhookEvent = 'jira:issue_updated'; assert.equal(jira.ingest(state, org, updated, runtime).ignored, true);
  const excluded = event(); excluded.issue.fields.labels = []; assert.equal(jira.ingest(state, org, excluded, runtime).ignored, true);
  const crossProject = event('OTHER-1'); crossProject.issue.fields.project.key = 'OTHER'; assert.throws(() => jira.ingest(state, org, crossProject, runtime), /outside/);
  const crossSite = event(); crossSite.issue.self = 'https://other.example.test/rest/api/2/issue/10001'; assert.throws(() => jira.ingest(state, org, crossSite, runtime), /outside/);
  assert.equal(state.runs.length, 0);
});
test('webhook authorization is team specific, fail closed and never stored in configuration', () => {
  const { org } = fixture(); const ref = jira.tokenReference(org.id); process.env[ref] = 'a'.repeat(40);
  try { assert.throws(() => jira.authorize(org, undefined), /authorization/); assert.throws(() => jira.authorize(org, 'Bearer wrong'), /authorization/); jira.authorize(org, 'Bearer ' + 'a'.repeat(40)); assert.ok(!JSON.stringify(org).includes('a'.repeat(40))); org.jira.enabled = false; assert.throws(() => jira.authorize(org, 'Bearer ' + 'a'.repeat(40)), /disabled/); } finally { delete process.env[ref]; }
});
test('triage hands off once to the team specialist with actual ticket input', () => {
  const { state, org } = fixture(); const result = jira.ingest(state, org, event('OPS-1', 'Ingress outage HTTP 503'), runtime);
  while (result.run.status !== 'completed') runtime.act(state, result.run, 'advance', { revision: result.run.revision }, { name: 'Demo' });
  const work = jira.continueTicket(state, result.run, runtime); assert.equal(work.agentId, 'incident-triage'); assert.equal(work.autoRun, true); assert.equal(work.plan.input.ticket, 'OPS-1'); assert.equal(work.organizationId, org.id);
  assert.equal(jira.continueTicket(state, result.run, runtime), null); assert.equal(state.runs.length, 2);
});
test('missing change inputs and unavailable specialists go to owner review', () => {
  const { state, org } = fixture();
  for (const summary of ['Renew TLS certificate', 'Patch CVE vulnerability', 'Upgrade nodepool']) assert.equal(jira.routeTicket({ summary }).agentId, null);
  const result = jira.ingest(state, org, event(), runtime);
  while (result.run.status !== 'completed') runtime.act(state, result.run, 'advance', { revision: result.run.revision }, { name: 'Demo' });
  state.agents.find(a => a.id === 'apex-troubleshooting').scope = 'unshared';
  assert.equal(jira.continueTicket(state, result.run, runtime), null); assert.equal(result.ticket.status, 'needs_owner'); assert.match(result.ticket.handoffError, /not available/);
});

test('incident queue mapping routes incidents even without keyword matches', () => {
  const { state, org } = fixture(); org.jira.ticketKind = 'incident';
  const result = jira.ingest(state, org, event('OPS-3', 'Network issue on node'), runtime);
  assert.equal(result.ticket.route.agentId, 'incident-triage'); assert.equal(result.run.plan.input.requestType, 'incident');
});

test('each team saves independent Jira URLs, queue names and optional descriptions', () => {
  const { state, org } = fixture(); const other = { id: 'b', name: 'Team B' }; state.organizations.push(other);
  jira.configure(state, org, { enabled: false, siteUrl: 'https://a.example.test/jira', projectKey: 'AA', queueNames: ['Requests', 'Incidents'], description: 'Team A support' });
  jira.configure(state, other, { enabled: false, siteUrl: 'https://b.example.test', projectKey: 'BB', queueNames: ['Service desk'] });
  assert.deepEqual(org.jira.queueNames, ['Requests', 'Incidents']); assert.equal(org.jira.description, 'Team A support');
  assert.equal(other.jira.description, ''); assert.equal(other.jira.siteUrl, 'https://b.example.test');
  const previous = structuredClone(org.jira);
  assert.throws(() => jira.configure(state, org, { enabled: false, siteUrl: 'https://a.example.test', projectKey: 'AA', queueNames: [] }), /queue names/);
  assert.deepEqual(org.jira, previous);
  const saved = JSON.parse(JSON.stringify(state)); assert.equal(saved.organizations[0].jira.description, 'Team A support');
});

test('two Jira sites and queues remain independent within one team', () => {
  const { state, org } = fixture();
  const incidents = jira.configure(state, org, { enabled: true, siteUrl: 'https://incident.example.test', projectKey: 'INC', queueNames: ['Incident queue'], ticketKind: 'incident' }, undefined, true);
  assert.equal(jira.connections(org).length, 2);
  const original = structuredClone(jira.connections(org)[0]);
  jira.configure(state, org, { enabled: false, siteUrl: incidents.siteUrl, projectKey: incidents.projectKey, queueNames: ['Updated incidents'], ticketKind: 'incident', description: 'Separate incident Jira' }, incidents.id);
  assert.deepEqual(jira.connections(org)[0], original);
  assert.equal(jira.connections(org)[1].queueNames[0], 'Updated incidents');
  assert.throws(() => jira.configure(state, org, { enabled: false }, 'another-team-connection'), /not found/);
  const service = jira.ingest(state, org, event(), runtime, false, org.jiraConnections[0]);
  const incidentEvent = event('INC-1', 'Network issue'); incidentEvent.issue.fields.project.key = 'INC'; incidentEvent.issue.self = 'https://incident.example.test/rest/api/2/issue/10002';
  const incident = jira.ingest(state, org, incidentEvent, runtime, true, org.jiraConnections[1]);
  assert.equal(service.ticket.requestType, 'auto'); assert.equal(incident.ticket.requestType, 'incident'); assert.equal(incident.ticket.connectionId, incidents.id);
  assert.equal(incident.ticket.route.agentId, 'incident-triage');
  assert.throws(() => jira.ingest(state, org, incidentEvent, runtime, false, org.jiraConnections[0]), /outside/);
});
