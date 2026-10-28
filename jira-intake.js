const { randomUUID, timingSafeEqual } = require('crypto');
function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
const tokenReference = (id, connectionId) => 'ORBIT_JIRA_WEBHOOK_TOKEN_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_') + (connectionId && connectionId !== 'legacy' ? '_' + connectionId.toUpperCase().replace(/[^A-Z0-9]/g, '_') : '');
function connections(org) { return org.jiraConnections?.length ? org.jiraConnections : org.jira ? [org.jira] : []; }
function initialize(state) {
  for (const org of state.organizations) {
    org.jiraConnections = connections(org);
    org.jiraConnections.forEach((config, index) => { config.id ||= index ? randomUUID() : 'legacy'; config.queueNames ||= [org.name]; config.description ||= ''; config.tokenReference ||= tokenReference(org.id, config.id); });
    org.jira = org.jiraConnections[0] || null;
  }
}
function resolveConnection(org, connectionId) {
  const config = connectionId ? connections(org).find(c => c.id === connectionId) : connections(org)[0];
  if (!config) fail('Jira connection not found in this team.', 404);
  return config;
}
function publicConnection(config) { return { ...config, tokenConfigured: (process.env[config.tokenReference] || '').length >= 32 }; }
function configure(state, org, body, connectionId, create = false) {
  if (typeof body.enabled !== 'boolean') fail('Choose whether Jira intake is enabled.');
  const previous = create ? null : connectionId ? resolveConnection(org, connectionId) : connections(org)[0];
  if (create && connections(org).length >= 10) fail('A team can save at most ten Jira connections.');
  const projectKey = String(body.projectKey || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(projectKey)) fail('Provide a valid Jira project key.');
  let site;
  try { site = new URL(String(body.siteUrl || '')); } catch { fail('Provide the Jira site HTTPS URL.'); }
  if (site.href.length > 256 || site.protocol !== 'https:' || site.username || site.password || site.search || site.hash) fail('Use a Jira HTTPS site URL without credentials or query parameters.');
  const siteUrl = site.origin + site.pathname.replace(/\/$/, '');
  const suppliedNames = body.queueNames === undefined ? (previous?.queueNames || [org.name]) : body.queueNames;
  if (!Array.isArray(suppliedNames) || !suppliedNames.length || suppliedNames.length > 10 || suppliedNames.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 120)) fail('Provide one to ten Jira queue names, each at most 120 characters.');
  const queueNames = [...new Set(suppliedNames.map(name => name.trim()))];
  const description = body.description === undefined ? (previous?.description || '') : body.description;
  if (typeof description !== 'string' || description.length > 2000) fail('Optional queue description must be at most 2000 characters.');
  const queueLabel = String(body.queueLabel || '').trim();
  if (queueLabel.length > 100 || /\s/.test(queueLabel)) fail('Queue label must be a single Jira label of at most 100 characters.');
  const ticketKind = body.ticketKind || 'auto';
  if (!['auto', 'service_request', 'incident'].includes(ticketKind)) fail('Choose automatic classification, service requests or incidents.');
  const id = previous?.id || (create ? randomUUID() : 'legacy');
  const config = { id, enabled: body.enabled, ticketKind, siteUrl, projectKey, queueNames, description: description.trim(), queueLabel, tokenReference: previous?.tokenReference || tokenReference(org.id, id) };
  const list = connections(org).slice(), index = previous ? list.indexOf(previous) : -1;
  if (index >= 0) list[index] = config; else list.push(config);
  org.jiraConnections = list; org.jira = list[0];
  return config;
}
function authorize(org, header, config = org?.jira) {
  if (!config?.enabled) fail('Live Jira intake is disabled for this connection.', 409);
  const token = process.env[config.tokenReference || tokenReference(org.id, config.id)];
  if (!token || token.length < 32) fail('Connection saved. Live webhook delivery needs a server-side secret configured by the platform administrator.', 503);
  const supplied = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from('Bearer ' + token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail('Invalid Jira webhook authorization.', 401);
}
function contentText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return [typeof value.text === 'string' ? value.text : '', ...(Array.isArray(value.content) ? value.content.map(contentText) : [])].filter(Boolean).join(' ');
}
function routeTicket(input) {
  if (input.requestType === 'incident') return { category: 'incident', agentId: 'incident-triage', reason: 'This team queue is configured for incidents requiring diagnosis and recovery validation.' };
  const text = (input.summary + ' ' + (input.description || '')).toLowerCase();
  if (/\b(outage|incident|503|service down|unavailable)\b/.test(text)) return { category: 'incident', agentId: 'incident-triage', reason: 'Service disruption requires incident diagnosis and explicit recovery validation.' };
  if (/vulnerab|\bcve-|security patch/.test(text)) return { category: 'security', agentId: null, reason: 'Security owner must supply verified findings, affected assets and vendor fix versions before remediation.' };
  if (/certificate|\btls\b|\bssl\b/.test(text)) return { category: 'certificate', agentId: null, reason: 'Certificate owner must confirm the hostname and saved team binding before issuing or renewing.' };
  if (/provision|upgrade|nodepool/.test(text)) return { category: 'change', agentId: null, reason: 'Team owner must confirm change inputs and target before a governed change plan is created.' };
  if (/apex|application|latency/.test(text)) return { category: 'application', agentId: 'apex-troubleshooting', reason: 'Read-only application diagnosis can start from the reported symptom.' };
  if (/\boke\b|kubernetes|cluster|pod|ingress|namespace/.test(text)) return { category: 'infrastructure', agentId: 'oke-troubleshooting', reason: 'Read-only cluster diagnosis can start from the reported symptom.' };
  return { category: 'service_request', agentId: null, reason: 'Team owner review is needed to identify a supported target and action.' };
}
function ingest(state, org, payload, runtime, demo = false, config = org.jira) {
  if (payload.webhookEvent !== 'jira:issue_created') return { ignored: true, reason: 'Only jira:issue_created starts ticket intake.' };
  const issue = payload.issue, fields = issue?.fields;
  if (!issue || !fields || typeof issue.key !== 'string' || !/^[A-Z][A-Z0-9_]+-\d+$/.test(issue.key)) fail('Provide a Jira issue key and fields.');
  const projectKey = demo ? (config?.projectKey || 'DEMO') : config.projectKey;
  if (fields.project?.key !== projectKey || !issue.key.startsWith(projectKey + '-')) fail('Issue is outside this team’s configured Jira project.', 403);
  if (!demo) {
    let self;
    try { self = new URL(issue.self); } catch { fail('Issue self URL is required for source binding.'); }
    const site = new URL(config.siteUrl);
    if (self.origin !== site.origin || !self.pathname.startsWith(site.pathname.replace(/\/$/, '') + '/rest/')) fail('Issue is outside this team’s configured Jira site.', 403);
    if (config.queueLabel && (!Array.isArray(fields.labels) || !fields.labels.includes(config.queueLabel))) return { ignored: true, reason: 'Issue does not match the configured queue label.' };
  }
  const summary = typeof fields.summary === 'string' ? fields.summary.trim() : '';
  if (!summary || summary.length > 1000) fail('Ticket summary is required and must be at most 1000 characters.');
  const description = contentText(fields.description).trim();
  if (description.length > 16000) fail('Ticket description exceeds the MVP limit of 16000 characters.');
  const descriptionExcerpt = description.slice(0, 1000);
  state.jiraTickets ||= [];
  const source = demo ? 'demo' : config.siteUrl;
  const duplicate = state.jiraTickets.find(t => t.organizationId === org.id && t.source === source && t.key === issue.key);
  if (duplicate) return { ticket: duplicate, created: false };
  const requestType = config?.ticketKind || 'auto';
  const route = routeTicket({ summary, description: descriptionExcerpt, requestType });
  const result = runtime.createRun(state, { organizationId: org.id, agentId: 'ticket-management', requestKey: 'jira/' + org.id + '/' + source + '/' + issue.key, title: issue.key + ': ' + summary, input: { ticket: issue.key, summary, requestType, description: descriptionExcerpt || 'No additional description supplied' } }, { name: 'Jira ticket intake' });
  result.run.autoRun = true;
  const ticket = { id: randomUUID(), organizationId: org.id, connectionId: config?.id || null, queueNames: config?.queueNames || [], key: issue.key, summary, description, requestType, ticketUrl: demo ? null : config.siteUrl + '/browse/' + issue.key, descriptionTruncated: description.length > 1000, source, mode: 'simulation', receivedAt: new Date().toISOString(), runId: result.run.id, status: 'triaging', route, owner: org.name + ' operations', priority: /highest|critical|high/i.test(fields.priority?.name || '') ? 'high' : 'normal', workRunId: null };
  result.run.source = { type: 'jira-ticket', ticketId: ticket.id };
  state.jiraTickets.push(ticket);
  return { ticket, run: result.run, created: true };
}
function continueTicket(state, run, runtime) {
  const ticket = state.jiraTickets?.find(t => t.id === run.source?.ticketId);
  if (!ticket) return null;
  if (run.status !== 'completed') { ticket.status = run.status === 'blocked' ? 'blocked' : run.status === 'stopped' ? 'stopped' : 'triaging'; return null; }
  if (ticket.handoffAt) return null;
  if (!ticket.route.agentId) { ticket.status = 'needs_owner'; ticket.handoffAt = new Date().toISOString(); return null; }
  const agentId = ticket.route.agentId;
  const input = agentId === 'incident-triage' ? { ...runtime.definitions[agentId].input, ticket: ticket.key, summary: ticket.summary } : { symptom: ticket.summary + (ticket.description ? ': ' + ticket.description : '') };
  if (input.symptom) input.symptom = input.symptom.slice(0, 1000);
  try {
    const result = runtime.createRun(state, { organizationId: ticket.organizationId, agentId, requestKey: 'jira-work/' + ticket.id, title: ticket.key + ': ' + ticket.summary, input }, { name: 'Ticket Management Agent' });
    result.run.autoRun = true; result.run.source = { type: 'jira-work', ticketId: ticket.id };
    ticket.workRunId = result.run.id; ticket.status = 'working'; ticket.handoffAt = new Date().toISOString();
    return result.run;
  } catch (error) { ticket.status = 'needs_owner'; ticket.handoffAt = new Date().toISOString(); ticket.handoffError = error.message; return null; }
}
module.exports = { configure, authorize, ingest, continueTicket, routeTicket, tokenReference, connections, initialize, resolveConnection, publicConnection };
