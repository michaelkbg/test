const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const inventory = require('../node-inventory');
test('team tenancy checkboxes persist independent compartment mappings and revoke deselected scope access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-tenancies-'));
  const oldConfig = process.env.OCI_CLI_CONFIG_FILE;
  process.env.OCI_CLI_CONFIG_FILE = path.join(dir, 'config');
  fs.writeFileSync(process.env.OCI_CLI_CONFIG_FILE, '[devapp]\ntenancy=ocid1.tenancy.oc1..dev\nregion=us-phoenix-1\n[prodapp]\ntenancy=ocid1.tenancy.oc1..prod\nregion=us-phoenix-1\n');
  try {
    const a = { id: 'a', name: 'A', agentTarget: { tenancy: 'demo-a', region: 'demo-region', allowedNodes: [] } }, b = { id: 'b', name: 'B', agentTarget: { tenancy: 'demo-b', region: 'demo-region', allowedNodes: [] } };
    const state = { organizations: [a,b] }; inventory.initialize(state);
    inventory.saveTeamSelections(state, a, { tenancies: [{ profileName: 'devapp', compartments: [{ name: 'Team A apps', id: 'ocid1.compartment.oc1..apps' }, { name: 'Team A tools', id: 'ocid1.compartment.oc1..tools' }] }] });
    inventory.saveTeamSelections(state, b, { tenancies: [{ profileName: 'prodapp', compartments: [{ name: 'Team B prod', id: 'ocid1.compartment.oc1..prod' }] }] });
    assert.equal(a.tenancySelections[0].compartments.length, 2); assert.equal(b.tenancySelections[0].name, 'prodapp');
    const scopeId = a.tenancySelections[0].compartments[0].scopeId;
    assert.equal(inventory.scopeFor(state, 'a', scopeId).tenancyId, 'ocid1.tenancy.oc1..dev');
    assert.throws(() => inventory.scopeFor(state, 'b', scopeId), /not found/);
    const before = JSON.stringify(a.tenancySelections);
    assert.throws(() => inventory.saveTeamSelections(state, a, { tenancies: [{ profileName: 'devapp', compartments: [{ name: '', id: 'not-an-ocid' }] }] }), /compartment/);
    assert.equal(JSON.stringify(a.tenancySelections), before);
    const saved = JSON.parse(JSON.stringify(state)); assert.equal(saved.organizations[0].tenancySelections[0].compartments[0].name, 'Team A apps');
    inventory.saveTeamSelections(state, a, { tenancies: [] });
    assert.throws(() => inventory.scopeFor(state, 'a', scopeId), /not selected/);
    assert.equal(b.tenancySelections[0].compartments.length, 1);
  } finally { if (oldConfig === undefined) delete process.env.OCI_CLI_CONFIG_FILE; else process.env.OCI_CLI_CONFIG_FILE = oldConfig; fs.rmSync(dir, { recursive: true, force: true }); }
});
