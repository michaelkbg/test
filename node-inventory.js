const { randomUUID, createHash } = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message, statusCode = 409) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function identity(scope) { const { id, organizationId, tenancyId, compartmentId, region, adapter, profileName, authMode } = scope; return { id, organizationId, tenancyId, compartmentId, region, adapter, profileName, authMode }; }
function key(scope) { return JSON.stringify([scope.organizationId, scope.tenancyId, scope.compartmentId, scope.region]); }
function profileCatalog(state) {
  const requested = state.inventoryProfileNames || ['Devapp', 'prodapp', 'oragitd', 'internalnonprod', 'internalprod', 'externalnonprod', 'externalprod'];
  const sections = {}; let section;
  try {
    for (const line of fs.readFileSync(process.env.OCI_CLI_CONFIG_FILE || path.join(os.homedir(), '.oci', 'config'), 'utf8').split(/\r?\n/)) {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/); if (header) { section = header[1]; sections[section] ||= {}; continue; }
      const session = line.match(/^\s*security_token_file\s*=\s*(.*)$/); if (session && section) sections[section].sessionToken = !!session[1].trim();
      const field = line.match(/^\s*(tenancy|region)\s*=\s*([^#;]+?)\s*$/); if (field && section) sections[section][field[1]] = field[2].trim();
    }
  } catch { /* Keep missing profiles visible as needing configuration. */ }
  return requested.map(name => {
    const profileName = Object.keys(sections).find(p => p.toLowerCase() === name.toLowerCase());
    const data = profileName ? { ...sections.DEFAULT, ...sections[profileName] } : {};
    return { name, profileName: profileName || name, configured: !!profileName && !!data.tenancy && !!data.region, tenancyId: data.tenancy || '', region: data.region || '', authMode: data.sessionToken ? 'security_token' : 'api_key' };
  });
}
async function listCompartments(state, profileName, runCLI = cli) {
  const profile = profileCatalog(state).find(p => p.profileName === profileName && p.configured);
  if (!profile) fail('This tenancy profile is not configured on the server.', 400);
  const result = await runCLI(['iam', 'compartment', 'list', '--compartment-id', profile.tenancyId, '--compartment-id-in-subtree', 'true', '--access-level', 'ANY', '--all', '--profile', profile.profileName, '--region', profile.region, '--auth', profile.authMode, '--output', 'json']);
  if (!Array.isArray(result.data) || result['opc-next-page']) fail('Compartment discovery returned an incomplete listing.');
  return { profile, compartments: result.data.filter(c => c['lifecycle-state'] === 'ACTIVE').map(c => ({ id: c.id, name: c.name, parentId: c['compartment-id'] })) };
}
function initialize(state) {
  state.nodeInventoryScopes ||= []; state.nodeInventories ||= [];
  for (const org of state.organizations) {
    if (!state.nodeInventoryScopes.some(s => s.organizationId === org.id)) state.nodeInventoryScopes.push({ id: 'default', organizationId: org.id, name: 'Demo compartment', tenancyId: org.agentTarget.tenancy, compartmentId: 'demo-compartment-' + org.id, region: org.agentTarget.region, adapter: 'simulation', profileName: '', demoNodes: (org.agentTarget.allowedNodes || []).map(id => ({ id, name: id, lifecycleState: 'RUNNING' })) });
  }
}
function scopeFor(state, organizationId, scopeId = 'default') {
  const scope = state.nodeInventoryScopes.find(s => s.organizationId === organizationId && s.id === scopeId); if (!scope) fail('Inventory scope not found in this team.', 404);
  const org = state.organizations.find(o => o.id === organizationId);
  if (scope.adapter === 'oci-cli' && Array.isArray(org?.tenancySelections) && !org.tenancySelections.some(t => t.profileName === scope.profileName && t.compartments.some(c => c.id === scope.compartmentId))) fail('This tenancy or compartment is not selected for this team.', 403);
  return scope;
}
function saveTeamSelections(state, org, body) {
  if (!Array.isArray(body.tenancies) || body.tenancies.length > 20) fail('Provide the selected team tenancies.', 400);
  const profiles = profileCatalog(state), seen = new Set();
  const selections = body.tenancies.map(t => {
    const profile = profiles.find(p => p.profileName === t.profileName);
    if (!profile || seen.has(t.profileName)) fail('Unknown or duplicate tenancy selection.', 400); seen.add(t.profileName);
    if (!Array.isArray(t.compartments) || t.compartments.length > 20) fail('Provide up to twenty compartments per tenancy.', 400);
    const ids = new Set();
    const compartments = t.compartments.map(c => {
      if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 120 || typeof c.id !== 'string' || !/^ocid1\.compartment\.[a-zA-Z0-9.]+$/.test(c.id) || c.id.length > 256 || ids.has(c.id)) fail('Each compartment needs a unique OCID and a name of at most 120 characters.', 400);
      ids.add(c.id); return { name: c.name.trim(), id: c.id };
    });
    return { name: profile.name, profileName: profile.profileName, tenancyId: profile.tenancyId, region: profile.region, configured: profile.configured, compartments };
  });
  const staged = { ...state, nodeInventoryScopes: structuredClone(state.nodeInventoryScopes) };
  for (const t of selections) {
    if (!t.configured) continue;
    for (const c of t.compartments) {
      const existing = staged.nodeInventoryScopes.find(s => s.organizationId === org.id && s.profileName === t.profileName && s.tenancyId === t.tenancyId && s.compartmentId === c.id && s.region === t.region);
      const scope = configure(staged, org, { ...(existing ? { id: existing.id } : {}), name: t.name + ' / ' + c.name, tenancyId: t.tenancyId, compartmentId: c.id, region: t.region, profileName: t.profileName, adapter: 'oci-cli' });
      c.scopeId = scope.id;
    }
  }
  state.nodeInventoryScopes = staged.nodeInventoryScopes;
  org.tenancySelections = selections;
  return selections;
}

function configure(state, org, body) {
  const adapter = body.adapter || 'simulation'; if (!['simulation', 'oci-cli'].includes(adapter)) fail('Choose simulation or OCI CLI inventory.', 400);
  const required = name => { const value = typeof body[name] === 'string' ? body[name].trim() : ''; if (!value || value.length > 256) fail(name + ' is required and must be at most 256 characters.', 400); return value; };
  const tenancyId = required('tenancyId'), compartmentId = required('compartmentId'), region = required('region'), name = required('name');
  const profileName = adapter === 'oci-cli' ? required('profileName') : '';
  if (!/^[a-zA-Z0-9_-]+$/.test(region) || (profileName && !/^[a-zA-Z0-9_.-]+$/.test(profileName))) fail('Region or profile name is invalid.', 400);
  if (adapter === 'oci-cli' && (!/^ocid1\.tenancy\.[a-zA-Z0-9.]+$/.test(tenancyId) || !/^ocid1\.compartment\.[a-zA-Z0-9.]+$/.test(compartmentId))) fail('Live discovery requires tenancy and compartment OCIDs.', 400);
  const previous = body.id ? state.nodeInventoryScopes.find(s => s.organizationId === org.id && s.id === body.id) : null;
  const compartmentName = body.compartmentName === undefined ? previous?.compartmentName || name.split(' / ').pop() : required('compartmentName');
  if (compartmentName.length > 120) fail('Compartment name must be at most 120 characters.', 400);
  if (body.id && !previous) fail('Inventory scope not found in this team.', 404);
  if (!previous && state.nodeInventoryScopes.filter(s => s.organizationId === org.id).length >= 200) fail('A team can configure at most two hundred inventory scopes.', 400);
  const authMode = adapter === 'oci-cli' ? (profileCatalog(state).find(p => p.profileName === profileName)?.authMode || 'api_key') : 'none';
  const scope = { id: previous?.id || randomUUID(), organizationId: org.id, name, compartmentName, tenancyId, compartmentId, region, adapter, profileName, authMode };
  if (adapter === 'simulation') {
    const nodes = body.demoNodes === undefined ? previous?.demoNodes || ['node-1', 'node-2'] : body.demoNodes;
    if (!Array.isArray(nodes) || nodes.length > 1000) fail('Provide up to 1000 simulated nodes.', 400);
    scope.demoNodes = nodes.map(n => typeof n === 'string' ? { id: n.trim(), name: n.trim(), lifecycleState: 'RUNNING' } : n);
    normalize(scope, scope.demoNodes);
  }
  if (previous) state.nodeInventoryScopes[state.nodeInventoryScopes.indexOf(previous)] = scope; else state.nodeInventoryScopes.push(scope);
  return scope;
}
function normalize(scope, rows) {
  if (!Array.isArray(rows)) fail('Inventory provider returned an incomplete node list.');
  const nodes = rows.map(row => {
    const id = row.id, compartmentId = row.compartmentId || row['compartment-id'] || (scope.adapter === 'simulation' ? scope.compartmentId : null);
    if (typeof id !== 'string' || !id || id.length > 256 || compartmentId !== scope.compartmentId) fail('Inventory provider returned an invalid or out-of-compartment node.');
    const lifecycleState = row.lifecycleState || row['lifecycle-state'];
    if (typeof lifecycleState !== 'string' || !lifecycleState) fail('Inventory provider did not return node lifecycle state.');
    return { id, name: row.name || row['display-name'] || id, compartmentId, lifecycleState, imageId: row.imageId || row['image-id'] || null, shape: row.shape || null };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  if (new Set(nodes.map(n => n.id)).size !== nodes.length) fail('Inventory provider returned duplicate node identities.');
  return nodes;
}
function storeSnapshot(state, scope, rows) {
  const nodes = normalize(scope, rows), inventoryHash = hash({ scope: identity(scope), nodes });
  const snapshot = { key: key(scope), scopeId: scope.id, ...identity(scope), fetchId: randomUUID(), fetchedAt: new Date().toISOString(), mode: scope.adapter === 'simulation' ? 'simulation' : 'live-read-only', complete: true, inventoryHash, nodes, eligibleNodeIds: nodes.filter(n => n.lifecycleState === 'RUNNING').map(n => n.id) };
  const previous = state.nodeInventories.find(s => s.key === snapshot.key);
  snapshot.history = [...(previous?.history || []), ...(previous ? [{ fetchId: previous.fetchId, inventoryHash: previous.inventoryHash, fetchedAt: previous.fetchedAt, nodeCount: previous.nodes.length }] : [])].slice(-10);
  if (previous) state.nodeInventories[state.nodeInventories.indexOf(previous)] = snapshot; else state.nodeInventories.push(snapshot);
  return snapshot;
}
function refreshSimulation(state, scope) { if (scope.adapter !== 'simulation') fail('Live inventory must be fetched before planning or executing.'); return storeSnapshot(state, scope, scope.demoNodes); }
async function cli(args) {
  return new Promise((resolve, reject) => execFile(process.env.ORBIT_OCI_CLI_PATH || 'oci', args, { timeout: 60000, maxBuffer: 20 * 1024 * 1024, shell: false }, (error, stdout) => {
    if (error) { const e = new Error(error.code === 'ENOENT' ? 'OCI CLI is unavailable on the server.' : 'OCI inventory read failed. Check the configured profile, IAM access and network connectivity.'); e.statusCode = 502; return reject(e); }
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('OCI CLI returned invalid JSON; inventory refresh failed.')); }
  }));
}
async function discoverOCI(scope, runCLI = cli) {
  const options = ['--profile', scope.profileName, '--region', scope.region, '--auth', scope.authMode || 'api_key', '--output', 'json'];
  let parent = scope.compartmentId; const visited = new Set();
  while (parent !== scope.tenancyId) {
    if (visited.has(parent) || visited.size >= 32 || !/^ocid1\.compartment\./.test(parent)) fail('Compartment does not belong to the configured tenancy.', 403);
    visited.add(parent);
    const result = await runCLI(['iam', 'compartment', 'get', '--compartment-id', parent, ...options]);
    if (result.data?.id !== parent || typeof result.data?.['compartment-id'] !== 'string') fail('Unable to verify compartment tenancy.', 403);
    parent = result.data['compartment-id'];
  }
  const result = await runCLI(['compute', 'instance', 'list', '--compartment-id', scope.compartmentId, '--all', ...options]);
  if (!Array.isArray(result.data) || result['opc-next-page']) fail('OCI returned an incomplete inventory listing.');
  return result.data;
}
async function refresh(state, scope, runCLI) {
  const binding = hash(identity(scope));
  try {
    const rows = scope.adapter === 'simulation' ? scope.demoNodes : await discoverOCI(scope, runCLI);
    const current = scopeFor(state, scope.organizationId, scope.id);
    if (hash(identity(current)) !== binding) fail('Inventory scope changed during discovery. Fetch again.');
    return storeSnapshot(state, current, rows);
  } catch (error) {
    const snapshot = state.nodeInventories.find(s => s.key === key(scope));
    if (snapshot) { snapshot.lastRefreshError = error.message; snapshot.lastRefreshAttemptAt = new Date().toISOString(); }
    throw error;
  }
}
function snapshotForPlan(state, org, scopeId, prepared) {
  const scope = scopeFor(state, org.id, scopeId), snapshot = prepared ? state.nodeInventories.find(s => s.scopeId === scope.id && s.organizationId === org.id && s.fetchId === prepared.fetchId) : refreshSimulation(state, scope);
  if (!snapshot || snapshot.lastRefreshError || hash(identity(snapshot)) !== hash(identity(scope)) || Date.now() - Date.parse(snapshot.fetchedAt) > 10000) fail('A successful fresh inventory fetch is required to create this plan.');
  if (!snapshot.eligibleNodeIds.length) fail('No RUNNING nodes were discovered in this compartment.');
  return { scope: identity(scope), inventoryHash: snapshot.inventoryHash, fetchedAt: snapshot.fetchedAt, fetchId: snapshot.fetchId, nodeIds: snapshot.eligibleNodeIds, allNodeCount: snapshot.nodes.length };
}
function assertScope(state, run) {
  if (!run.plan.inventory) fail('This older vulnerability plan needs fresh compartment discovery. Stop it and create a new plan.');
  const binding = run.plan.inventory.scope, current = scopeFor(state, run.organizationId, binding.id);
  if (hash(identity(current)) !== hash(binding)) fail('Inventory tenancy, compartment or provider binding changed. Create a new plan for approval.');
}
function needsRefresh(run) {
  const step = run.plan.steps[run.cursor];
  return run.agentId === 'oke-vulnerabilities' && run.status === 'ready' && !!step?.node && (step.name.toLowerCase().includes('preflight') || ['kubernetes', 'package-manager'].includes(step.tool));
}
function assertFresh(state, run) {
  assertScope(state, run);
  const binding = run.plan.inventory.scope, scope = scopeFor(state, run.organizationId, binding.id);
  const snapshot = state.nodeInventories.find(s => s.key === key(scope));
  if (!snapshot || snapshot.lastRefreshError || Date.now() - Date.parse(snapshot.fetchedAt) > 5000 || snapshot.fetchId !== run.latestInventory?.fetchId || run.latestInventory?.step !== run.cursor) fail('Fetch updated compartment nodes before this remediation step.');
  if (snapshot.inventoryHash !== run.plan.inventory.inventoryHash) fail('Compartment node inventory changed. Stop and create a fresh plan for renewed approval.');
  if (!snapshot.eligibleNodeIds.includes(run.plan.steps[run.cursor].node)) fail('Current node is no longer RUNNING in the approved compartment.');
  return snapshot;
}
async function prepareAdvance(state, run) {
  if (!needsRefresh(run)) return;
  assertScope(state, run);
  const scope = scopeFor(state, run.organizationId, run.plan.inventory.scope.id), snapshot = await refresh(state, scope);
  run.latestInventory = { fetchId: snapshot.fetchId, fetchedAt: snapshot.fetchedAt, inventoryHash: snapshot.inventoryHash, step: run.cursor };
  assertFresh(state, run);
}
function saveCompartment(state, org, body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const id = typeof body.compartmentId === 'string' ? body.compartmentId.trim() : '';
  const profileName = typeof body.profileName === 'string' ? body.profileName.trim() : '';
  if (!name || name.length > 120) fail('Provide a compartment name of at most 120 characters.', 400);
  if (id && (!/^ocid1\.compartment\.[a-zA-Z0-9.]+$/.test(id) || id.length > 256)) fail('Provide a valid compartment OCID or leave it empty until onboarding.', 400);
  if (profileName && !profileCatalog(state).some(p => p.profileName === profileName)) fail('Unknown tenancy selection.', 400);
  const entries = org.availableCompartments || [];
  const existing = entries.find(c => c.profileName === profileName && c.name.toLowerCase() === name.toLowerCase());
  const entry = { name, id, profileName };
  if (existing) Object.assign(existing, entry);
  else { if (entries.length >= 200) fail('This team already has 200 saved compartments.', 400); entries.push(entry); }
  org.availableCompartments = entries;
  return existing || entry;
}
module.exports = { initialize, saveCompartment, saveTeamSelections, profileCatalog, listCompartments, configure, scopeFor, identity, key, refreshSimulation, refresh, discoverOCI, snapshotForPlan, assertScope, needsRefresh, assertFresh, prepareAdvance };
