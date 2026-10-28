const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const runtime = require('./agent-runtime');
const jira = require('./jira-intake');
const inventory = require('./node-inventory');
const PORT = process.env.PORT || 8000;
const currentUser = { name: 'Michael Kabongo', role: 'Platform admin' };
const storePath = process.env.ORBIT_STORE_PATH || path.join(__dirname, 'data', 'store.json');
const sharedAgentCatalog = [
  ['oke-vulnerabilities', 'Vulnerability Remediation Agent', 'Infrastructure security'],
  ['apex-vulnerabilities', 'APEX Vulnerabilities Agent', 'Application security'],
  ['oke-cluster-provisioning', 'OKE Cluster Provisioning Agent', 'Infrastructure provisioning'],
  ['cluster-nodepool-upgrade', 'Cluster & Nodepool Upgrade Agent', 'Infrastructure lifecycle'],
  ['ticket-management', 'Ticket Management Agent', 'Operations'],
  ['tpls-management', 'TLS Certificate Management Agent', 'Security & certificates'],
  ['incident-triage', 'Incident Triage Agent', 'Incident response'],
  ['notification', 'Notification Agent', 'Communications'],
  ['apex-troubleshooting', 'APEX Troubleshooting Agent', 'Application operations'],
  ['oke-troubleshooting', 'OKE Troubleshooting Agent', 'Infrastructure operations']
].map(([id, name, domain]) => ({ id, name, domain, success: '98.7%', scope: 'shared', owner: 'Platform Governance' }));
const initialState = {
  organizations: [
    { id: 'ee-orchestration', name: 'EE Orchestration', description: 'Enterprise execution orchestration', integrations: ['Web portal', 'REST / GraphQL', 'Jira', 'Scheduled jobs'] },
    { id: 'computer-ops', name: 'Computer Ops', description: 'Infrastructure operations', integrations: ['Slack', 'OKE APIs', 'OCI resources', 'Vulnerability scans'] }
  ],
  policies: [
    { id: 'production-approval', name: 'Production change approval', description: 'Human-in-the-loop required', enabled: true },
    { id: 'tenant-isolation', name: 'Tenant data isolation', description: 'Organization scope enforced', enabled: true },
    { id: 'cost-threshold', name: 'Cost threshold', description: 'Estimated run cost: $42.80', enabled: true }
  ],
  agents: sharedAgentCatalog,
  tasks: [{ id: 'REQ-8492', title: 'Provision a production OKE cluster', organizationId: 'ee-orchestration', requester: 'Jordan Lee', risk: 'high', status: 'awaiting_approval', createdAt: new Date().toISOString() }],
  audit: [{ id: 'aud-1', type: 'Policy pass', detail: 'Production provisioning · REQ-8492', at: new Date().toISOString() }, { id: 'aud-2', type: 'Agent invoked', detail: 'Vulnerability Response · REQ-8491', at: new Date(Date.now() - 4 * 60000).toISOString() }, { id: 'aud-3', type: 'Approval requested', detail: 'Database schema update · REQ-8487', at: new Date(Date.now() - 12 * 60000).toISOString() }]
};
function load() { try { return JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { fs.mkdirSync(path.dirname(storePath), { recursive: true }); fs.writeFileSync(storePath, JSON.stringify(initialState, null, 2)); return initialState; } }
let state = load();
state.organizations = (state.organizations || []).map(org => ({ ...org, approvers: Array.isArray(org.approvers) && org.approvers.length ? org.approvers : [org.name + ' Lead'] }));
const defaultUsage = (org, index) => ({ organizationId: org.id, period: new Date().toISOString().slice(0, 7), modelCost: [1180, 860, 640][index % 3], toolCost: [470, 520, 260][index % 3], infrastructureCost: [610, 740, 320][index % 3], executions: [1380, 970, 540][index % 3], budget: [4200, 3600, 2800][index % 3], previousMonthCost: [3560, 3090, 1760][index % 3], drivers: [[{ name: 'OKE Cluster Provisioning Agent', type: 'Agent', cost: 720 }, { name: 'OCI resources', type: 'Infrastructure', cost: 610 }, { name: 'Model inference', type: 'Intelligence', cost: 540 }], [{ name: 'OKE Troubleshooting Agent', type: 'Agent', cost: 640 }, { name: 'Vulnerability scanners', type: 'Tool', cost: 520 }, { name: 'OCI resources', type: 'Infrastructure', cost: 470 }], [{ name: 'Ticket Management Agent', type: 'Agent', cost: 380 }, { name: 'Model inference', type: 'Intelligence', cost: 330 }, { name: 'Jira integration', type: 'Tool', cost: 180 }]][index % 3] });
state.usage = Array.isArray(state.usage) ? state.usage : [];
state.organizations.forEach((org, index) => { if (!state.usage.some(usage => usage.organizationId === org.id)) state.usage.push(defaultUsage(org, index)); });
state.usage = state.usage.map(usage => { const index = state.organizations.findIndex(org => org.id === usage.organizationId), org = state.organizations[index]; return org ? { ...defaultUsage(org, index), ...usage } : usage; });
// Existing demo stores predate agent ownership. Keep them usable while adding
// explicit governance metadata for the shared catalog.
const storedAgents = state.agents || [];
const deletedSharedAgentIds = new Set(state.deletedSharedAgentIds || []);
const catalogAgents = sharedAgentCatalog.map(template => {
  const stored = storedAgents.find(agent => agent.id === template.id);
  return stored && stored.scope === 'unshared' ? { ...template, scope: 'unshared', unsharedAt: stored.unsharedAt } : template;
}).filter(agent => !deletedSharedAgentIds.has(agent.id));
const dedicatedAgents = storedAgents.filter(agent => agent.scope === 'team').map((agent, index) => ({
  id: agent.id || agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent-' + index,
  scope: 'team',
  owner: agent.owner || 'Team',
  ...agent
}));
state.agents = [...catalogAgents, ...dedicatedAgents];
state.deletedSharedAgentIds = [...deletedSharedAgentIds];
runtime.initialize(state);
state.jiraTickets ||= [];
jira.initialize(state);
save();
function save() { fs.mkdirSync(path.dirname(storePath), { recursive: true }); fs.writeFileSync(storePath + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(storePath + '.tmp', storePath); }
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function audit(type, detail, context = {}) { state.audit.unshift({ id: randomUUID(), type, detail, ...context, at: new Date().toISOString() }); }
function getBody(req) { return new Promise((resolve, reject) => { let raw = ''; let tooLarge = false; req.on('data', c => { if (raw.length + c.length > 512 * 1024) tooLarge = true; else if (!tooLarge) raw += c; }); req.on('end', () => { try { if (tooLarge) { const error = new Error('Request body exceeds 512 KB.'); error.statusCode = 413; throw error; } resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } }); }); }
function selectAgent(org, title, preferredAgentId) {
  const available = state.agents.filter(agent => agent.scope === 'shared' || (agent.scope === 'team' && agent.organizationId === org.id));
  if (preferredAgentId) { const preferred = available.find(a => a.id === preferredAgentId); if (!preferred) { const error = new Error('Preferred agent is not available to this team.'); error.statusCode = 403; throw error; } return { agent: preferred, selection: 'preferred' }; }
  const text = title.toLowerCase();
  const id = /incident|outage|triage/.test(text) ? 'incident-triage' : /tls|tpls|certificate/.test(text) ? 'tpls-management' : /vulnerab|cve|patch/.test(text) ? (text.includes('apex') ? 'apex-vulnerabilities' : 'oke-vulnerabilities') : /upgrade|nodepool/.test(text) ? 'cluster-nodepool-upgrade' : /provision|cluster/.test(text) ? 'oke-cluster-provisioning' : /ticket/.test(text) ? 'ticket-management' : /notification|notify/.test(text) ? 'notification' : /troubleshoot|diagnos/.test(text) ? (text.includes('apex') ? 'apex-troubleshooting' : 'oke-troubleshooting') : 'oke-troubleshooting';
  return { agent: available.find(a => a.id === id) || null, selection: 'automatic' };
}
function taskForRun(run) {
  let task = state.tasks.find(t => t.runId === run.id);
  if (!task) { task = { id: 'REQ-' + randomUUID().slice(0, 8), runId: run.id, title: run.title, organizationId: run.organizationId, requester: run.requester, agentId: run.agentId, agentName: run.agentName, risk: runtime.definitions[run.agentId].readOnly ? 'low' : 'high', createdAt: run.createdAt }; state.tasks.unshift(task); }
  task.status = run.status; task.mode = run.mode;
  if (run.completedAt) task.completedAt = run.completedAt;
  return task;
}
async function prepareRun(body) {
  if (body.agentId !== 'oke-vulnerabilities') return body;
  const org = state.organizations.find(o => o.id === body.organizationId);
  if (!org) { const e = new Error('Team not found.'); e.statusCode = 404; throw e; }
  if (!state.agents.some(a => a.id === body.agentId && (a.scope === 'shared' || (a.scope === 'team' && a.organizationId === org.id)))) { const e = new Error('Agent is not available to this team.'); e.statusCode = 403; throw e; }
  const scope = inventory.scopeFor(state, org.id, body.input?.inventoryScopeId || body.inventoryScopeId || 'default');
  try { const snapshot = await inventory.refresh(state, scope); save(); return { ...body, inventorySnapshot: { fetchId: snapshot.fetchId } }; }
  catch (error) { save(); throw error; }
}
function costSummary() { const sharedPlatformCost = 3600, totalExecutions = state.usage.reduce((total, usage) => total + usage.executions, 0) || 1, day = new Date().getDate(), daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate(); return { period: new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }), sharedPlatformCost, teams: state.usage.map(usage => { const directCost = usage.modelCost + usage.toolCost + usage.infrastructureCost, sharedAllocation = Math.round(sharedPlatformCost * usage.executions / totalExecutions * 100) / 100, totalCost = directCost + sharedAllocation; return { ...usage, directCost, sharedAllocation, totalCost, forecast: Math.round(totalCost / day * daysInMonth * 100) / 100, budgetRemaining: usage.budget - totalCost, monthOverMonth: Math.round((totalCost - usage.previousMonthCost) / usage.previousMonthCost * 1000) / 10 }; }) }; }
function queueDueRenewals() {
  const result = runtime.scheduleDueRenewals(state);
  result.scheduled.forEach(run => { run.autoRun = true; taskForRun(run); audit('Renewal planned', run.id + ' · simulation · awaiting workflow review', { organizationId: run.organizationId, runId: run.id, planHash: run.planHash }); });
  result.blocked.forEach(binding => audit('Renewal scheduling blocked', binding.bindingId + ' · ' + binding.error, { organizationId: binding.organizationId }));
  if (result.scheduled.length || result.blocked.length) save();
  return result;
}
function publicState() { return { ...state, inventoryProfiles: inventory.profileCatalog(state), organizations: state.organizations.map(org => ({ ...org, jiraConnections: jira.connections(org).map(jira.publicConnection), jira: org.jira ? jira.publicConnection(org.jira) : null })), currentUser, costs: costSummary(), metrics: { tasksGoverned: 24892 + state.tasks.length, compliance: '99.98%', response: '1.8s', activeAgents: state.agents.filter(agent => agent.scope !== 'unshared').length } }; }
function serveFile(req, res) {
  const requested = new URL(req.url, 'http://localhost').pathname;
  const fileName = requested === '/' ? 'index.html' : requested.slice(1);
  // Expose browser assets only; never serve the JSON database or backend source.
  const publicFiles = new Set(['index.html', 'app.js', 'styles.css', 'agents.html', 'agents.js', 'agents.css', 'workflows.html', 'workflows.js', 'workflows.css', 'audit.html', 'audit.js', 'policies.html', 'policies.js', 'governance.css', 'team.html', 'team.js', 'team.css', 'profile.html', 'profile.js', 'profile.css', 'costs.html', 'costs.js', 'costs.css']);
  if (!publicFiles.has(fileName)) return json(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  res.writeHead(200, { 'Content-Type': types[path.extname(fileName)] + '; charset=utf-8' }); fs.createReadStream(path.join(__dirname, fileName)).pipe(res);
}
const server = http.createServer(async (req, res) => { try {
  if (req.method === 'GET' && req.url === '/api/state') return json(res, 200, publicState());
  const url = new URL(req.url, 'http://localhost');
  const compartmentCatalogMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/compartments$/);
  if (req.method === 'POST' && compartmentCatalogMatch) {
    const org = state.organizations.find(o => o.id === decodeURIComponent(compartmentCatalogMatch[1]));
    if (!org) return json(res, 404, { error: 'Team not found.' });
    const entry = inventory.saveCompartment(state, org, await getBody(req));
    audit('Compartment saved', org.name + ' · ' + entry.name, { organizationId: org.id });
    save(); return json(res, 201, entry);
  }
  if (req.method === 'POST' && url.pathname === '/api/node-inventory/compartments') {
    const body = await getBody(req);
    if (!state.organizations.some(o => o.id === body.organizationId)) return json(res, 404, { error: 'Team not found.' });
    return json(res, 200, await inventory.listCompartments(state, body.profileName));
  }
  const tenancyMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/tenancies$/);
  if (req.method === 'PUT' && tenancyMatch) {
    const org = state.organizations.find(o => o.id === decodeURIComponent(tenancyMatch[1]));
    if (!org) return json(res, 404, { error: 'Team not found.' });
    const selections = inventory.saveTeamSelections(state, org, await getBody(req));
    audit('Team tenancies saved', org.name + ' · ' + selections.map(t => t.name).join(', '), { organizationId: org.id }); save(); return json(res, 200, { tenancies: selections });
  }
  const scopeMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/node-inventory(?:\/([^/]+)\/refresh)?$/);
  if (scopeMatch) {
    const org = state.organizations.find(o => o.id === decodeURIComponent(scopeMatch[1]));
    if (!org) return json(res, 404, { error: 'Team not found.' });
    if (req.method === 'GET' && !scopeMatch[2]) return json(res, 200, { scopes: state.nodeInventoryScopes.filter(s => s.organizationId === org.id), inventories: state.nodeInventories.filter(s => s.organizationId === org.id) });
    if (req.method === 'POST' && !scopeMatch[2]) { const scope = inventory.configure(state, org, await getBody(req)); audit('Inventory scope saved', org.name + ' · ' + scope.tenancyId + ' · ' + scope.compartmentId, { organizationId: org.id }); save(); return json(res, 201, scope); }
    if (req.method === 'POST' && scopeMatch[2]) {
      const scope = inventory.scopeFor(state, org.id, decodeURIComponent(scopeMatch[2]));
      try { const snapshot = await inventory.refresh(state, scope); audit('Node inventory refreshed', scope.name + ' · ' + snapshot.nodes.length + ' nodes', { organizationId: org.id }); save(); return json(res, 200, snapshot); }
      catch(error) { save(); throw error; }
    }
  }
  const jiraConfigMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/jira(?:\/connections(?:\/([^/]+))?)?$/);
  if (jiraConfigMatch && (req.method === 'PUT' || (req.method === 'POST' && url.pathname.endsWith('/connections')))) {
    const org = state.organizations.find(o => o.id === decodeURIComponent(jiraConfigMatch[1]));
    if (!org) return json(res, 404, { error: 'Team not found.' });
    const config = jira.configure(state, org, await getBody(req), jiraConfigMatch[2] && decodeURIComponent(jiraConfigMatch[2]), req.method === 'POST');
    audit('Jira connection saved', org.name + ' · ' + config.projectKey, { organizationId: org.id }); save();
    return json(res, req.method === 'POST' ? 201 : 200, jira.publicConnection(config));
  }
  const jiraEventMatch = url.pathname.match(/^\/api\/integrations\/jira\/([^/]+)(?:\/([^/]+))?\/issue-created$/);
  const jiraDemoMatch = url.pathname.match(/^\/api\/organizations\/([^/]+)\/jira\/demo-ticket$/);
  if (req.method === 'POST' && (jiraEventMatch || jiraDemoMatch)) {
    const match = jiraEventMatch || jiraDemoMatch, org = state.organizations.find(o => o.id === decodeURIComponent(match[1]));
    if (!org) return json(res, 404, { error: 'Team not found.' });
    let config;
    if (jiraEventMatch && !jira.connections(org).length) return json(res, 409, { error: 'Live Jira intake is disabled for this team.' });
    if (jiraEventMatch) { config = jira.resolveConnection(org, jiraEventMatch[2] && decodeURIComponent(jiraEventMatch[2])); jira.authorize(org, req.headers.authorization, config); }
    const body = await getBody(req);
    if (jiraDemoMatch) config = body.connectionId ? jira.resolveConnection(org, body.connectionId) : jira.connections(org)[0];
    const result = jira.ingest(state, org, body, runtime, !!jiraDemoMatch, config);
    if (result.created) { taskForRun(result.run); audit('Jira ticket received', result.ticket.key + ' · ' + result.run.id + ' · simulation', { organizationId: org.id, runId: result.run.id }); save(); }
    return json(res, result.created ? 202 : 200, result.ignored ? result : { ticket: result.ticket, duplicate: !result.created });
  }
  if (req.method === 'POST' && url.pathname === '/api/renewals/schedule') return json(res, 200, queueDueRenewals());
  if (req.method === 'GET' && url.pathname === '/api/workflows') return json(res, 200, runtime.definitions);
  if (req.method === 'GET' && url.pathname === '/api/runs') {
    const organizationId = url.searchParams.get('organizationId');
    if (!state.organizations.some(o => o.id === organizationId)) return json(res, 400, { error: 'Valid organizationId is required.' });
    return json(res, 200, state.runs.filter(r => r.organizationId === organizationId));
  }
  if (req.method === 'POST' && req.url === '/api/runs') {
    const body = await prepareRun(await getBody(req)), result = runtime.createRun(state, body, currentUser);
    if (result.created) result.run.autoRun = true;
    taskForRun(result.run);
    if (result.created) audit('Workflow planned', result.run.agentName + ' · ' + result.run.id + ' · simulation', { organizationId: result.run.organizationId, runId: result.run.id, planHash: result.run.planHash });
    save(); return json(res, result.created ? 201 : 200, result.run);
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/([^/]+))?$/);
  if (runMatch && req.method === 'GET' && !runMatch[2]) return json(res, 200, runtime.scopedRun(state, decodeURIComponent(runMatch[1]), url.searchParams.get('organizationId')));
  if (runMatch && req.method === 'POST' && runMatch[2]) {
    const body = await getBody(req), run = runtime.scopedRun(state, decodeURIComponent(runMatch[1]), body.organizationId);
    if (runMatch[2] === 'advance') { try { await inventory.prepareAdvance(state, run); save(); } catch (error) { save(); throw error; } }
    runtime.act(state, run, runMatch[2], body, currentUser);
    if (['resume', 'approve', 'validate'].includes(runMatch[2])) run.autoRun = true;
    taskForRun(run);
    const ticket = state.jiraTickets.find(t => t.runId === run.id || t.workRunId === run.id); if (ticket) ticket.status = run.status === 'ready' ? 'working' : run.status;
    audit('Workflow ' + runMatch[2], run.agentName + ' · ' + run.id + ' · ' + run.status + ' · simulation', { organizationId: run.organizationId, runId: run.id, planHash: run.planHash, revision: run.revision });
    save(); return json(res, 200, run);
  }
  if (req.method === 'POST' && req.url === '/api/organizations') { const body = await getBody(req), name = String(body.name || '').trim(); if (!name) return json(res, 400, { error: 'Team name is required.' }); if (state.organizations.some(o => o.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: 'That team already exists.' }); const org = { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, description: String(body.description || 'New team'), integrations: ['Web portal', 'REST / GraphQL', 'Jira', 'Slack', 'Scheduled jobs'], approvers: [name + ' Lead'] }; org.agentTarget = runtime.targetFor(org); state.organizations.push(org); inventory.initialize(state); state.usage.push(defaultUsage(org, state.organizations.length - 1)); audit('Team onboarded', name + ' · workspace created'); save(); return json(res, 201, org); }
  const deleteTeamMatch = req.url.match(/^\/api\/organizations\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteTeamMatch) { const id = decodeURIComponent(deleteTeamMatch[1]), index = state.organizations.findIndex(o => o.id === id); if (index === -1) return json(res, 404, { error: 'Team not found.' }); if (state.tasks.some(t => t.organizationId === id && !['completed', 'stopped'].includes(t.status))) return json(res, 409, { error: 'Complete or cancel this team’s active tasks before deletion.' }); const removed = state.organizations.splice(index, 1)[0]; audit('Team removed', removed.name + ' · workspace deleted'); save(); return json(res, 200, { id }); }
  const approverMatch = req.url.match(/^\/api\/organizations\/([^/]+)\/approvers$/);
  if (req.method === 'PATCH' && approverMatch) { const body = await getBody(req), org = state.organizations.find(o => o.id === decodeURIComponent(approverMatch[1])); if (!org) return json(res, 404, { error: 'Team not found.' }); const approvers = [...new Set((Array.isArray(body.approvers) ? body.approvers : []).map(value => String(value).trim()).filter(Boolean))]; if (!approvers.length) return json(res, 400, { error: 'Each team needs at least one designated approver.' }); org.approvers = approvers; audit('Approval routing updated', org.name + ' · ' + approvers.join(', ')); save(); return json(res, 200, org); }
  if (req.method === 'POST' && req.url === '/api/tasks') {
    const body = await getBody(req), org = state.organizations.find(o => o.id === body.organizationId), title = String(body.title || '').trim();
    if (!org || !title) return json(res, 400, { error: 'A task title and valid organization are required.' });
    const routing = selectAgent(org, title, String(body.preferredAgentId || ''));
    if (!routing.agent) return json(res, 409, { error: 'No permitted specialist matches this task.' });
    const result = runtime.createRun(state, await prepareRun({ organizationId: org.id, agentId: routing.agent.id, title, ...(body.input ? { input: body.input } : {}) }), currentUser);
    if (result.created) result.run.autoRun = true;
    const task = taskForRun(result.run); task.agentSelection = routing.selection; task.approver = org.approvers[0];
    if (result.created) audit('Workflow planned', title + ' · ' + task.id + ' · ' + result.run.id + ' · simulation', { organizationId: org.id, runId: result.run.id, planHash: result.run.planHash });
    save(); return json(res, result.created ? 201 : 200, task);
  }
  if (req.method === 'POST' && req.url === '/api/agents') {
    const body = await getBody(req), name = String(body.name || '').trim(), organizationId = String(body.organizationId || '');
    const org = state.organizations.find(o => o.id === organizationId);
    if (!name || !org || !String(body.purpose || '').trim() || !String(body.technicalOwner || '').trim()) return json(res, 400, { error: 'Agent name, purpose, technical owner, and a valid team are required.' });
    if (state.agents.some(agent => agent.name.toLowerCase() === name.toLowerCase() && agent.organizationId === organizationId)) return json(res, 409, { error: 'This team already has an agent with that name.' });
    const list = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    const agent = { id: randomUUID(), name, domain: String(body.domain || 'Team capability').trim(), purpose: String(body.purpose).trim(), capabilities: list(body.capabilities), invocationMethod: String(body.invocationMethod || 'API endpoint'), endpoint: String(body.endpoint || '').trim(), allowedTools: list(body.allowedTools), dataScope: String(body.dataScope || 'Team tenant data only'), credentialReference: String(body.credentialReference || '').trim(), riskClass: String(body.riskClass || 'Standard'), approvalRequirement: String(body.approvalRequirement || 'Team policy'), technicalOwner: String(body.technicalOwner).trim(), runbook: String(body.runbook || '').trim(), validationRollback: String(body.validationRollback || '').trim(), monitoringSignals: list(body.monitoringSignals), success: 'New', scope: 'team', organizationId: org.id, owner: org.name, createdAt: new Date().toISOString() };
    state.agents.push(agent);
    audit('Dedicated agent registered', agent.name + ' · ' + org.name + ' · team-scoped');
    save();
    return json(res, 201, agent);
  }
  const agentMatch = req.url.match(/^\/api\/agents\/([^/]+)$/);
  if (req.method === 'DELETE' && agentMatch) {
    const id = decodeURIComponent(agentMatch[1]), index = state.agents.findIndex(agent => agent.id === id);
    if (index === -1) return json(res, 404, { error: 'Agent not found.' });
    const agent = state.agents[index];
    if (agent.scope === 'team') {
      state.agents.splice(index, 1);
      audit('Dedicated agent deleted', agent.name + ' · ' + agent.owner);
    } else {
      state.agents.splice(index, 1);
      state.deletedSharedAgentIds = [...new Set([...(state.deletedSharedAgentIds || []), agent.id])];
      audit('Platform agent deleted', agent.name + ' · removed by platform admin');
    }
    save();
    return json(res, 200, { id });
  }
  const unshareMatch = req.url.match(/^\/api\/agents\/([^/]+)\/unshare$/);
  if (req.method === 'POST' && unshareMatch) {
    const agent = state.agents.find(agent => agent.id === decodeURIComponent(unshareMatch[1]));
    if (!agent) return json(res, 404, { error: 'Agent not found.' });
    if (agent.scope !== 'shared') return json(res, 400, { error: 'Only shared agents can be removed from the shared catalog.' });
    agent.scope = 'unshared';
    agent.unsharedAt = new Date().toISOString();
    audit('Shared agent unshared', agent.name + ' · removed from platform catalog');
    save();
    return json(res, 200, agent);
  }
  const approveMatch = req.url.match(/^\/api\/tasks\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const task = state.tasks.find(t => t.id === decodeURIComponent(approveMatch[1]));
    if (!task) return json(res, 404, { error: 'Task not found.' });
    if (!task.runId) {
      const org = state.organizations.find(o => o.id === task.organizationId), routing = org && selectAgent(org, task.title, task.agentId);
      if (!routing || !routing.agent) return json(res, 409, { error: 'No permitted agent available.' });
      const result = runtime.createRun(state, await prepareRun({ organizationId: org.id, agentId: routing.agent.id, title: task.title }), currentUser);
      task.runId = result.run.id; task.agentId = result.run.agentId; task.agentName = result.run.agentName; taskForRun(result.run);
      audit('Legacy request planned', task.title + ' · ' + task.id + ' · simulation'); save(); return json(res, 200, task);
    }
    const body = await getBody(req), run = runtime.scopedRun(state, task.runId, task.organizationId);
    runtime.act(state, run, 'approve', body, currentUser); run.autoRun = true; taskForRun(run); audit('Approval granted', task.title + ' · ' + task.id + ' · simulation'); save(); return json(res, 200, task);
  }
  const policyMatch = req.url.match(/^\/api\/policies\/([^/]+)$/);
  if (req.method === 'PATCH' && policyMatch) { const body = await getBody(req), policy = state.policies.find(p => p.id === decodeURIComponent(policyMatch[1])); if (!policy) return json(res, 404, { error: 'Policy not found.' }); policy.enabled = Boolean(body.enabled); audit(policy.enabled ? 'Policy enabled' : 'Policy paused', policy.name); save(); return json(res, 200, policy); }
  return serveFile(req, res);
} catch (error) { return json(res, error.statusCode || 400, { error: error.message || 'Request failed.' }); } });
let advancing = false, executionActive = false;
async function advanceAutomaticRuns() {
  if (advancing || !executionActive) return;
  advancing = true;
  try {
  for (const run of [...state.runs].reverse()) {
    if (!run.autoRun || run.status !== 'ready') continue;
    const revision = run.revision;
    try {
      await inventory.prepareAdvance(state, run);
      if (!executionActive) return;
      if (run.revision !== revision || run.status !== 'ready') { save(); continue; }
      runtime.act(state, run, 'advance', { revision: run.revision, planHash: run.planHash }, currentUser);
      delete run.waitingForTarget;
      taskForRun(run);
      const work = jira.continueTicket(state, run, runtime);
      if (work) { taskForRun(work); audit('Ticket work routed', work.title + ' · ' + work.agentName, { organizationId: work.organizationId, runId: work.id }); }
      const ticket = state.jiraTickets.find(t => t.workRunId === run.id);
      if (ticket) { ticket.status = run.status === 'completed' ? 'work_complete' : run.status === 'ready' ? 'working' : run.status; ticket.updatedAt = new Date().toISOString(); }
      audit('Workflow progressed', run.agentName + ' · ' + run.id + ' · ' + run.status + ' · simulation', { organizationId: run.organizationId, runId: run.id, planHash: run.planHash, revision: run.revision });
      save();
    } catch (error) {
      if (run.revision !== revision || run.status !== 'ready') { save(); continue; }
      if (error.code === 'TARGET_BUSY') {
        if (!run.waitingForTarget) { run.waitingForTarget = true; save(); }
        continue;
      }
      run.status = 'blocked'; run.resumeStatus = 'ready'; run.error = error.message;
      run.revision++; run.updatedAt = new Date().toISOString(); taskForRun(run);
      const ticket = state.jiraTickets.find(t => t.runId === run.id || t.workRunId === run.id); if (ticket) { ticket.status = 'blocked'; ticket.error = error.message; }
      audit('Workflow blocked', run.agentName + ' · ' + run.id + ' · ' + error.message, { organizationId: run.organizationId, runId: run.id });
      save();
    }
  }
  } finally { advancing = false; }
}
let executionTimer;
server.on('listening', () => { executionActive = true; executionTimer = setInterval(advanceAutomaticRuns, Math.max(25, Number(process.env.ORBIT_STEP_INTERVAL_MS) || 500)); executionTimer.unref(); });
server.on('close', () => { executionActive = false; clearInterval(executionTimer); });
if (require.main === module) {
  queueDueRenewals();
  const renewalTimer = setInterval(queueDueRenewals, 60000); renewalTimer.unref();
  server.on('close', () => clearInterval(renewalTimer));
  server.listen(PORT, () => console.log('Orbit — Specialist Agent Operations is running at http://localhost:' + PORT));
}
module.exports = server;
