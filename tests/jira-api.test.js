const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('Jira webhook receives, authorizes, deduplicates and automatically routes ticket work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-jira-api-'));
  process.env.ORBIT_STORE_PATH = path.join(dir, 'store.json'); process.env.ORBIT_STEP_INTERVAL_MS = '25';
  const token = 'team-a-test-webhook-token-'.repeat(2); process.env.ORBIT_JIRA_WEBHOOK_TOKEN_EE_ORCHESTRATION = token;
  const server = require('../server'); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.ORBIT_JIRA_WEBHOOK_TOKEN_EE_ORCHESTRATION; });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(url, body, method = 'POST', auth) { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; }
  const config = await request('/api/organizations/ee-orchestration/jira', { enabled: true, siteUrl: 'https://jira.example.test', projectKey: 'OPS', queueLabel: 'team-a' }, 'PUT'); assert.equal(config.status, 200);
  const payload = { webhookEvent: 'jira:issue_created', issue: { key: 'OPS-1', self: 'https://jira.example.test/rest/api/2/issue/10000', fields: { project: { key: 'OPS' }, summary: 'Application latency increased', labels: ['team-a'] } } };
  const endpoint = '/api/integrations/jira/ee-orchestration/issue-created';
  assert.equal((await request(endpoint, payload)).status, 401);
  assert.equal((await request(endpoint, payload, 'POST', 'wrong')).status, 401);
  const accepted = await request(endpoint, payload, 'POST', token); assert.equal(accepted.status, 202);
  const duplicate = await request(endpoint, payload, 'POST', token); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
  let state;
  for (let i = 0; i < 150; i++) { state = (await request('/api/state', undefined, 'GET')).body; if (state.jiraTickets[0].status === 'work_complete') break; await new Promise(resolve => setTimeout(resolve, 25)); }
  const ticket = state.jiraTickets[0]; assert.equal(ticket.status, 'work_complete');
  assert.equal(state.runs.find(r => r.id === ticket.runId).agentId, 'ticket-management');
  assert.equal(state.runs.find(r => r.id === ticket.workRunId).agentId, 'apex-troubleshooting');
  assert.equal(state.jiraTickets.length, 1); assert.ok(!JSON.stringify(state).includes(token));
  const persisted = JSON.parse(fs.readFileSync(process.env.ORBIT_STORE_PATH)); assert.equal(persisted.jiraTickets[0].status, 'work_complete');
  assert.equal((await request('/api/integrations/jira/computer-ops/issue-created', payload, 'POST', token)).status, 409);
  const second = await request('/api/organizations/ee-orchestration/jira/connections', { enabled: true, siteUrl: 'https://second-jira.example.test', projectKey: 'INC', queueNames: ['Incident queue'], ticketKind: 'incident' });
  assert.equal(second.status, 201); const connection = second.body;
  process.env[connection.tokenReference] = 'second-connection-private-token-'.repeat(2);
  try {
    const incidentPayload = { webhookEvent: 'jira:issue_created', issue: { key: 'INC-1', self: 'https://second-jira.example.test/rest/api/2/issue/10001', fields: { project: { key: 'INC' }, summary: 'Network issue' } } };
    const secondEndpoint = '/api/integrations/jira/ee-orchestration/' + connection.id + '/issue-created';
    assert.equal((await request(secondEndpoint, incidentPayload, 'POST', token)).status, 401);
    assert.equal((await request(secondEndpoint, incidentPayload, 'POST', process.env[connection.tokenReference])).status, 202);
    const updated = await request('/api/organizations/ee-orchestration/jira/connections/' + connection.id, { enabled: false, siteUrl: connection.siteUrl, projectKey: connection.projectKey, queueNames: ['Updated incidents'], description: 'Separate source' }, 'PUT'); assert.equal(updated.status, 200);
    const snapshot = (await request('/api/state', undefined, 'GET')).body;
    const team = snapshot.organizations.find(o => o.id === 'ee-orchestration');
    assert.equal(team.jiraConnections.length, 2); assert.equal(team.jiraConnections[0].projectKey, 'OPS'); assert.equal(team.jiraConnections[1].queueNames[0], 'Updated incidents');
    assert.equal((await request('/api/organizations/computer-ops/jira/connections/' + connection.id, { enabled: false }, 'PUT')).status, 404);
  } finally { delete process.env[connection.tokenReference]; }
  const demo = await request('/api/organizations/computer-ops/jira/demo-ticket', { webhookEvent: 'jira:issue_created', issue: { key: 'DEMO-2', fields: { project: { key: 'DEMO' }, summary: 'Request owner review' } } }); assert.equal(demo.status, 202);
});
