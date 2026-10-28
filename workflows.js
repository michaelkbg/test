const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || 'Request failed');
  return body;
}
let state, definitions, selectedRunId, busy = false, refreshing = false;
const runStatus = r => r.status === 'ready' && r.autoRun ? (r.waitingForTarget ? 'Waiting for target' : 'Running') : r.status.replaceAll('_', ' ');
const query = new URLSearchParams(location.search);
function team() { return state.organizations.find(o => o.id === $('#teamSelect').value); }
function teamRuns() { return state.runs.filter(r => r.organizationId === team()?.id); }
function selectedRun() { return teamRuns().find(r => r.id === selectedRunId); }
function displayAgent() {
  const d = definitions[$('#agentSelect').value];
  $('#createPlan').disabled = !d;
  $('#agentDescription').textContent = d?.description || 'This team has no available runtime agents.';
  $('#inputFields').innerHTML = d ? Object.entries(d.input).filter(([key]) => !(d.kind === 'vulnerability' && key === 'nodes')).map(([key, value]) => `<label>${escapeHTML(key.replace(/([A-Z])/g, ' $1').toUpperCase())}${key === 'inventoryScopeId' ? '<select name="inventoryScopeId" id="planInventoryScope">' + inventoryScopes().map(s => '<option value="' + escapeHTML(s.id) + '">' + escapeHTML(s.name + ' · ' + s.compartmentId) + '</option>').join('') + '</select>' : key === 'operation' ? '<select name="operation"><option value="create">Create</option><option value="renew">Renew</option></select>' : `<input name="${escapeHTML(key)}" value="${key === 'fixedVersion' ? '' : escapeHTML(Array.isArray(value) ? value.join(', ') : value)}"${key === 'fixedVersion' ? ' placeholder="' + 'Fixed Version"' : ''} required maxlength="1000">`}</label>`).join('') : '';
  $('#targetPreview').textContent = JSON.stringify(team()?.agentTarget, null, 2);
  $('#nodeInventorySection').hidden = d?.kind !== 'vulnerability';
  if (d?.kind === 'vulnerability') { $('#planInventoryScope').onchange = displayInventory; displayInventory(); }
}
function displayTeam() {
  editingInventoryScopeId = undefined;
  discoveredCompartments = [];
  $('#knownInventoryTenancy').value = '';
  $('#compartmentCatalogMessage').textContent = '';
  const preferred = $('#agentSelect').value || query.get('agent');
  const agents = state.agents.filter(a => definitions[a.id] && (a.scope === 'shared' || a.organizationId === team()?.id));
  $('#agentSelect').innerHTML = agents.map(a => `<option value="${escapeHTML(a.id)}">${escapeHTML(a.name)}</option>`).join('');
  if (agents.some(a => a.id === preferred)) $('#agentSelect').value = preferred;
  displayAgent();
  selectedRunId = teamRuns().some(r => r.id === selectedRunId) ? selectedRunId : teamRuns()[0]?.id;
  displayRuns();
}
function displayRuns() {
  const runs = teamRuns();
  $('#runMetrics').innerHTML = [['WORKFLOWS', runs.length, 'Saved for this team'], ['WAITING FOR REVIEW', runs.filter(r => r.status === 'awaiting_approval').length, 'Exact plan approval required'], ['COMPLETED', runs.filter(r => r.status === 'completed').length, 'With simulated step evidence']].map(([label, number, note]) => `<article><small>${label}</small><b>${number}</b><span>${note}</span></article>`).join('');
  $('#runList').innerHTML = runs.length ? runs.map(r => `<button class="run-card ${r.id === selectedRunId ? 'selected' : ''}" data-run="${escapeHTML(r.id)}"><b>${escapeHTML(r.agentName)}</b><span class="status ${escapeHTML(r.status)}">${escapeHTML(runStatus(r))}</span><small>${escapeHTML(r.title)} · ${r.cursor}/${r.plan.steps.length} steps · ${escapeHTML(new Date(r.createdAt).toLocaleString())}</small></button>`).join('') : '<p class="empty">No workflows yet. Create a plan to begin.</p>';
  $('#bindings').innerHTML = state.certificateBindings.filter(b => b.organizationId === team()?.id).map(b => `<div class="binding"><b>${escapeHTML(b.hostname)} · active simulated certificate</b>Secret: ${escapeHTML(b.secretName)}<br>Expires: ${escapeHTML(new Date(b.active.notAfter).toLocaleDateString())}<br>Next renewal due: ${escapeHTML(new Date(b.nextRenewalAt).toLocaleDateString())}</div>`).join('');
  displayTickets();
  if ($('#agentSelect').value === 'oke-vulnerabilities') displayInventory();
  displayRun();
}
function displayRun() {
  const r = selectedRun();
  if (!r) { $('#runDetail').innerHTML = '<div class="empty-state"><span>◉</span><h2>Your next action starts with a plan.</h2><p>Choose a specialist to preview its target and inputs.</p></div>'; return; }
  const terminal = ['completed', 'stopped'].includes(r.status);
  const canApprove = team().approvers.some(a => a.toLowerCase() === state.currentUser.name.toLowerCase());
  const controls = terminal ? '' : `${r.status === 'ready' && !r.autoRun ? '<button class="primary" data-action="start">Run plan →</button>' : ''}${['paused', 'blocked'].includes(r.status) ? '<button class="secondary" data-action="resume">Reconcile & resume</button>' : '<button class="secondary" data-action="pause">Pause</button>'}<button class="delete" data-action="stop">Stop</button>`;
  let gate = '';
  if (r.status === 'awaiting_approval') gate = `<div class="gate"><p><b>Review the exact plan before approval.</b> Approval binds the inputs, target and all remaining steps to the plan hash below. Source checks and merged commits are simulated.</p>${canApprove ? '<button class="primary" data-action="approve">Approve as ' + escapeHTML(state.currentUser.name) + '</button>' : '<p>Only a designated team approver can approve. Current approvers: ' + escapeHTML(team().approvers.join(', ')) + '.</p><a class="work-link" href="/team.html?team=' + encodeURIComponent(team().id) + '#governance">Manage team approvers →</a>'}</div>`;
  if (r.status === 'awaiting_customer') gate = '<div class="gate"><p><b>Technical recovery does not close the incident.</b> Record an explicit customer confirmation for this simulated case.</p><textarea id="validationEvidence" aria-label="Customer validation evidence" placeholder="Customer confirmed the service is healthy…"></textarea><button class="primary" data-action="validate">Record customer confirmation</button></div>';
  if (r.status === 'blocked') gate = `<div class="gate"><b>${escapeHTML(r.error)}</b><p>The target lock is retained. Review the failed receipt, then reconcile and retry this simulated step or stop the workflow.</p></div>`;
  $('#runDetail').innerHTML = `<div class="run-top"><div><p class="eyebrow">${escapeHTML(r.mode.toUpperCase())} · ${escapeHTML(r.id)}</p><h2>${escapeHTML(r.agentName)}</h2><span class="status ${escapeHTML(r.status)}">${escapeHTML(runStatus(r))}</span></div><div class="run-controls">${controls}</div></div><div class="progress-track"><i style="width:${Math.round(r.cursor / r.plan.steps.length * 100)}%"></i></div>${gate}<div class="detail-grid"><div><p class="eyebrow">PERSISTED WORKFLOW STEPS</p><ol class="steps">${r.plan.steps.map((s, i) => `<li class="${i < r.cursor ? 'done' : i === r.cursor && !terminal ? 'current' : ''}"><i>${i < r.cursor ? '✓' : i + 1}</i><div><b>${escapeHTML(s.name)}</b><small>${escapeHTML(s.tool)}${s.gate ? ' · ' + escapeHTML(s.gate) + ' gate' : ''}</small></div></li>`).join('')}</ol></div><div class="evidence"><p class="eyebrow">PLAN & EXECUTION EVIDENCE</p><p>Each action saves a revision and receipt. Reopening this workflow resumes at its current checkpoint.</p><div class="hash">SHA-256: ${escapeHTML(r.planHash)}</div>${r.plan.inventory ? `<p>Planned inventory: ${r.plan.inventory.nodeIds.length} RUNNING nodes · fetched ${escapeHTML(new Date(r.plan.inventory.fetchedAt).toLocaleString())}<br>Compartment: ${escapeHTML(r.plan.inventory.scope.compartmentId)}</p>` : ''}<details><summary>Review immutable plan and team target</summary><pre>${escapeHTML(JSON.stringify(r.plan, null, 2))}</pre></details><h3>${r.receipts.length} step receipts · ${r.approvals.length} approvals</h3>${r.receipts.length ? r.receipts.slice().reverse().map(receipt => `<details class="receipt"><summary>${receipt.outcome === 'failed' ? '⚠' : '✓'} ${escapeHTML(receipt.name)} · simulation</summary><pre>${escapeHTML(JSON.stringify(receipt, null, 2))}</pre></details>`).join('') : '<p>Execution starts automatically. Step receipts appear here as the plan runs.</p>'}${r.status === 'paused' && r.resumeStatus === 'ready' && !r.plan.steps[r.cursor]?.gate ? '<button class="secondary" data-action="failure">Simulate a step failure</button>' : ''}</div></div>`;
}
async function refresh() {
  state = await api('/api/state');
  const selectedTeam = $('#teamSelect').value || query.get('team');
  $('#teamSelect').innerHTML = state.organizations.map(o => `<option value="${escapeHTML(o.id)}">${escapeHTML(o.name)}</option>`).join('');
  if (state.organizations.some(o => o.id === selectedTeam)) $('#teamSelect').value = selectedTeam;
  if (!team()) throw Error('Create a team in the command center to start a workflow.');
  const currentAgent = $('#agentSelect').value;
  const accessible = state.agents.filter(a => definitions[a.id] && (a.scope === 'shared' || a.organizationId === team().id));
  if (!accessible.some(a => a.id === currentAgent)) displayTeam(); else displayRuns();
}
$('#teamSelect').onchange = displayTeam;
$('#agentSelect').onchange = displayAgent;
$('#refresh').onclick = () => refresh().catch(showError);
function showError(error) { $('#error').textContent = error.message; }
$('#runList').onclick = event => { const button = event.target.closest('[data-run]'); if (!button) return; selectedRunId = button.dataset.run; displayRuns(); };
$('#launchForm').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true; $('#createPlan').disabled = true; $('#error').textContent = '';
  try {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    if ('nodes' in input) input.nodes = input.nodes.split(',').map(n => n.trim()).filter(Boolean);
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ organizationId: team().id, agentId: $('#agentSelect').value, input }) });
    selectedRunId = run.id; await refresh(); $('#runDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showError(error); } finally { busy = false; $('#createPlan').disabled = !definitions[$('#agentSelect').value]; }
};
$('#runDetail').onclick = async event => {
  const button = event.target.closest('[data-action]'); if (!button || busy) return;
  const r = selectedRun(), action = button.dataset.action;
  busy = true; button.disabled = true; $('#error').textContent = '';
  try {
    const latest = await api('/api/runs/' + encodeURIComponent(r.id) + '?organizationId=' + encodeURIComponent(r.organizationId));
    const body = { organizationId: r.organizationId, revision: latest.revision, planHash: r.planHash };
    
    if (action === 'validate') Object.assign(body, { confirmed: true, evidence: $('#validationEvidence').value });
    await api('/api/runs/' + encodeURIComponent(r.id) + '/' + action, { method: 'POST', body: JSON.stringify(body) });
    await refresh();
  } catch (error) { showError(error); await refresh().catch(showError); } finally { busy = false; button.disabled = false; }
};
(async () => { try { definitions = await api('/api/workflows'); selectedRunId = query.get('run'); await refresh(); } catch (error) { showError(error); } })();

setInterval(async () => {
  if (!state || busy || refreshing) return;
  refreshing = true;
  try {
    const next = await api('/api/state');
    if (busy) return;
    if (JSON.stringify([state.runs, state.certificateBindings, state.organizations, state.agents, state.jiraTickets, state.nodeInventoryScopes, state.nodeInventories]) !== JSON.stringify([next.runs, next.certificateBindings, next.organizations, next.agents, next.jiraTickets, next.nodeInventoryScopes, next.nodeInventories])) {
      state = next;
      const openDetails = [...$('#runDetail').querySelectorAll('details')].map(d => d.open);
      const customerEvidence = $('#validationEvidence')?.value;
      displayRuns();
      $('#runDetail').querySelectorAll('details').forEach((d, i) => { d.open = !!openDetails[i]; });
      if (customerEvidence !== undefined && $('#validationEvidence')) $('#validationEvidence').value = customerEvidence;
    }
  } catch (error) { showError(error); } finally { refreshing = false; }
}, 750);

function displayTickets() {
  $('#jiraConfigLink').href = '/team.html?team=' + encodeURIComponent(team().id) + '#jiraIntake';
  const settings = team().jiraConnections || (team().jira ? [team().jira] : []);
  $('.ticket-note').textContent = settings.length ? settings.map(c => c.projectKey + ': ' + (c.queueNames || []).join(', ') + ' | ' + c.siteUrl).join(' · ') + '. Downstream agent work is simulated.' : 'Save your team’s Jira URL, queue names and optional description using Configure team queue. You can also simulate a ticket-created event here.';
  const tickets = (state.jiraTickets || []).filter(t => t.organizationId === team().id).slice().reverse();
  $('#jiraTicketList').innerHTML = tickets.length ? tickets.map(t => `<div class="ticket-row"><div><b>${escapeHTML(t.key)} · ${escapeHTML(t.summary)}</b><p>${escapeHTML(t.route.category)} · ${escapeHTML(t.owner)} · ${(t.source === 'demo' ? 'Demo event' : 'Jira event') + (t.queueNames?.length ? ' · ' + escapeHTML(t.queueNames.join(', ')) : '')}<br>${escapeHTML(t.route.reason)}${t.handoffError ? '<br>' + escapeHTML(t.handoffError) : ''}</p><a href="/workflows.html?team=${encodeURIComponent(team().id)}&run=${encodeURIComponent(t.runId)}">Ticket triage →</a>${t.workRunId ? `<a href="/workflows.html?team=${encodeURIComponent(team().id)}&run=${encodeURIComponent(t.workRunId)}">Specialist work →</a>` : ''}</div><div><span class="status">${escapeHTML(t.status === 'work_complete' ? 'Simulated work complete' : t.status.replaceAll('_', ' '))}</span></div></div>`).join('') : '<p class="ticket-note">No ticket events received for this team yet.</p>';
}
function populateDemoConnections() {
  const configs = team().jiraConnections || (team().jira ? [team().jira] : []);
  $('#demoJiraConnection').innerHTML = configs.length ? configs.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.projectKey + ' · ' + c.queueNames.join(', '))}</option>`).join('') : '<option value="">Local demo queue</option>';
  setDemoTicketKey();
}
function demoConnection() { return (team().jiraConnections || []).find(c => c.id === $('#demoJiraConnection').value) || team().jira; }
function setDemoTicketKey() { $('#ticketDemoForm').elements.ticket.value = (demoConnection()?.projectKey || 'DEMO') + '-' + Date.now().toString().slice(-8); }
$('#demoJiraConnection').onchange = setDemoTicketKey;
$('#simulateTicket').onclick = () => { $('#ticketDemoForm').hidden = false; populateDemoConnections(); };
$('#cancelTicketDemo').onclick = () => { $('#ticketDemoForm').hidden = true; };
$('#ticketDemoForm').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true; const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const result = await api('/api/organizations/' + encodeURIComponent(team().id) + '/jira/demo-ticket', { method: 'POST', body: JSON.stringify({ connectionId: data.connectionId || undefined, webhookEvent: 'jira:issue_created', issue: { key: data.ticket, fields: { project: { key: demoConnection()?.projectKey || 'DEMO' }, summary: data.summary, description: data.description } } }) });
    selectedRunId = result.ticket.runId; form.hidden = true; $('#error').textContent = ''; await refresh();
  } catch (error) { showError(error); } finally { busy = false; button.disabled = false; }
};

function inventoryScopes() { const selections = team()?.tenancySelections; return (state.nodeInventoryScopes || []).filter(s => s.organizationId === team()?.id && (s.adapter === 'simulation' || !Array.isArray(selections) || selections.some(t => t.profileName === s.profileName && t.compartments.some(c => c.id === s.compartmentId)))); }
function selectedInventoryScope() { return inventoryScopes().find(s => s.id === $('#planInventoryScope')?.value); }
let editingInventoryScopeId;
let discoveredCompartments = [], compartmentChoices = [];
function displayCompartmentChoices() {
  const profileName = $('#knownInventoryTenancy').value;
  const select = $('#knownInventoryCompartment'), selected = select.value;
  const saved = (team()?.availableCompartments || []).filter(c => !c.profileName || c.profileName === profileName);
  const mapped = (team()?.tenancySelections || []).filter(t => !profileName || t.profileName === profileName).flatMap(t => t.compartments);
  const scoped = inventoryScopes().filter(s => !profileName || s.profileName === profileName).map(s => ({ name: s.compartmentName || s.name.split(' / ').pop(), id: s.compartmentId }));
  compartmentChoices = [];
  for (const c of [...discoveredCompartments, ...saved, ...mapped, ...scoped]) {
    if (!compartmentChoices.some(x => c.id ? x.id === c.id : x.name === c.name)) compartmentChoices.push(c);
  }
  select.innerHTML = '<option value="">Choose a compartment</option>' + compartmentChoices.map((c, i) => `<option value="${i}">${escapeHTML(c.name)}${c.id ? ' · ' + escapeHTML(c.id) : ' · OCID needed'}</option>`).join('');
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}
function displayInventory() {
  $('#teamTenanciesLink').href = '/team.html?team=' + encodeURIComponent(team().id) + '#teamTenancies';
  const scope = selectedInventoryScope();
  const snapshot = (state.nodeInventories || []).find(s => s.organizationId === team().id && s.scopeId === scope?.id);
  $('#refreshInventory').disabled = busy || !scope;
  $('#nodeInventorySummary').innerHTML = scope ? `<p class="ticket-note"><b>${escapeHTML(scope.name)}</b><br>Tenancy: ${escapeHTML(scope.tenancyId)}<br>Compartment: ${escapeHTML(scope.compartmentId)} · ${escapeHTML(scope.region)}<br>Provider: ${escapeHTML(scope.adapter)}</p>${snapshot ? `<p class="ticket-note">${snapshot.nodes.length} nodes saved · ${snapshot.eligibleNodeIds.length} RUNNING<br>Last successful fetch: ${escapeHTML(new Date(snapshot.fetchedAt).toLocaleString())}${snapshot.lastRefreshError ? '<br>Latest refresh failed: ' + escapeHTML(snapshot.lastRefreshError) + '. The previous snapshot cannot authorize remediation.' : ''}</p><div class="inventory-node-list">${snapshot.nodes.map(n => `<div>${escapeHTML(n.name)} · ${escapeHTML(n.lifecycleState)}<small>${escapeHTML(n.id)}</small></div>`).join('')}</div>` : '<p class="ticket-note">No inventory fetched yet. Create plan & run fetches it automatically, or select Fetch updated nodes.</p>'}` : '<p class="ticket-note">Configure an inventory scope for this team.</p>';
  const known = $('#knownInventoryTenancy'), selectedKnown = known.value;
  known.innerHTML = '<option value="">Enter a scope manually</option>' + (state.inventoryProfiles || []).map(p => `<option value="${escapeHTML(p.profileName)}">${escapeHTML(p.name)}${p.configured ? '' : ' · profile setup needed'}</option>`).join(''); known.value = selectedKnown;
  displayCompartmentChoices();
  const selector = $('#inventoryScopeEditor');
  if (!editingInventoryScopeId) { editingInventoryScopeId = scope?.id || 'new'; populateInventoryEditor(); }
  else if (!selector.options.length) populateInventoryEditor();
}
function populateInventoryEditor() {
  const scopes = inventoryScopes();
  $('#inventoryScopeEditor').innerHTML = scopes.map(s => `<option value="${escapeHTML(s.id)}">${escapeHTML(s.name)}</option>`).join('') + '<option value="new">Add tenancy / compartment</option>';
  if (editingInventoryScopeId !== 'new' && !scopes.some(s => s.id === editingInventoryScopeId)) editingInventoryScopeId = scopes[0]?.id || 'new';
  $('#inventoryScopeEditor').value = editingInventoryScopeId;
  const scope = scopes.find(s => s.id === editingInventoryScopeId) || {}, form = $('#inventoryScopeForm');
  for (const name of ['name', 'tenancyId', 'compartmentName', 'compartmentId', 'region', 'profileName']) form.elements[name].value = scope[name] || '';
  form.elements.compartmentName.value = scope.compartmentName || (scope.name ? scope.name.split(' / ').pop() : '');
  form.elements.adapter.value = scope.adapter || 'simulation';
  form.elements.demoNodes.value = (scope.demoNodes || []).map(n => typeof n === 'string' ? n : n.id).join('\n');
}
$('#inventoryScopeEditor').onchange = event => { editingInventoryScopeId = event.target.value; populateInventoryEditor(); };
$('#inventoryScopeForm').onsubmit = async event => {
  event.preventDefault(); if (busy) return; busy = true;
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    if (editingInventoryScopeId !== 'new') body.id = editingInventoryScopeId;
    if (body.adapter === 'simulation') body.demoNodes = body.demoNodes.split(/\r?\n/).map(n => n.trim()).filter(Boolean); else delete body.demoNodes;
    const scope = await api('/api/organizations/' + encodeURIComponent(team().id) + '/node-inventory', { method: 'POST', body: JSON.stringify(body) });
    editingInventoryScopeId = scope.id; $('#error').textContent = ''; await refresh(); displayAgent(); $('#planInventoryScope').value = scope.id; populateInventoryEditor(); displayInventory();
  } catch (error) { showError(error); } finally { busy = false; }
};
$('#refreshInventory').onclick = async () => {
  if (busy || !selectedInventoryScope()) return; busy = true; $('#refreshInventory').disabled = true;
  try { await api('/api/organizations/' + encodeURIComponent(team().id) + '/node-inventory/' + encodeURIComponent(selectedInventoryScope().id) + '/refresh', { method: 'POST' }); $('#error').textContent = ''; await refresh(); }
  catch (error) { showError(error); } finally { busy = false; displayInventory(); }
};

$('#knownInventoryTenancy').onchange = event => {
  discoveredCompartments = []; displayCompartmentChoices();
  const profile = (state.inventoryProfiles || []).find(p => p.profileName === event.target.value); if (!profile) return;
  editingInventoryScopeId = 'new'; populateInventoryEditor();
  const form = $('#inventoryScopeForm'); form.elements.name.value = profile.name; form.elements.tenancyId.value = profile.tenancyId; form.elements.region.value = profile.region; form.elements.profileName.value = profile.profileName; form.elements.adapter.value = 'oci-cli';
  $('#error').textContent = profile.configured ? '' : 'This tenancy needs an OCI CLI profile on the server before live discovery.';
};
$('#discoverCompartments').onclick = async () => {
  if (busy || !$('#knownInventoryTenancy').value) return; busy = true; const button = $('#discoverCompartments'); button.disabled = true;
  try {
    const result = await api('/api/node-inventory/compartments', { method: 'POST', body: JSON.stringify({ organizationId: team().id, profileName: $('#knownInventoryTenancy').value }) });
    discoveredCompartments = result.compartments; displayCompartmentChoices(); $('#error').textContent = '';
  } catch (error) { showError(error); } finally { busy = false; button.disabled = false; }
};
$('#knownInventoryCompartment').onchange = event => {
  if (event.target.value === '') return;
  const compartment = compartmentChoices[Number(event.target.value)];
  const profile = (state.inventoryProfiles || []).find(p => p.profileName === $('#knownInventoryTenancy').value);
  editingInventoryScopeId = 'new'; populateInventoryEditor();
  const form = $('#inventoryScopeForm');
  form.elements.name.value = (profile ? profile.name + ' / ' : '') + compartment.name;
  form.elements.compartmentName.value = compartment.name;
  form.elements.compartmentId.value = compartment.id || '';
  if (profile) { form.elements.tenancyId.value = profile.tenancyId; form.elements.region.value = profile.region; form.elements.profileName.value = profile.profileName; form.elements.adapter.value = 'oci-cli'; }
  $('#error').textContent = compartment.id ? '' : 'Enter this compartment’s OCID before saving a live inventory scope.';
};
$('#compartmentCatalogForm').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  busy = true; const form = event.currentTarget, button = form.querySelector('button'), organizationId = team().id;
  button.disabled = true;
  try {
    const body = { ...Object.fromEntries(new FormData(form)), profileName: $('#knownInventoryTenancy').value };
    await api('/api/organizations/' + encodeURIComponent(organizationId) + '/compartments', { method: 'POST', body: JSON.stringify(body) });
    await refresh(); displayCompartmentChoices(); form.reset(); $('#error').textContent = '';
    $('#compartmentCatalogMessage').textContent = 'Compartment saved to this team’s available list.';
  } catch (error) { showError(error); } finally { busy = false; button.disabled = false; }
};
