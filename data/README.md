# Local demo database

`store.json` is the JSON database used by the local governance MVP. It stores teams, designated approvers, target configuration, registered agents, governed tasks, policies, audit events, workflows, exact-plan approvals, step receipts, certificate bindings and resource locks.

The server adds new runtime fields to older demo stores at startup. Each mutation writes a temporary file and atomically renames it over the store. Use one server process per store. Workflow checkpoints and locks survive browser refreshes and server restarts. The TLS scheduler starts due simulated renewal plans automatically and pauses them at required approval gates.

Set `ORBIT_STORE_PATH` to use a separate database. Tests use temporary isolated stores and leave this file untouched. Back up this file before resetting demo data.

This is local demo storage. It has no authenticated identity boundary, encryption, distributed locks or database transactions. Certificate records contain simulated metadata and vault references; do not put passwords or private keys here. The server does not expose this directory through static routes.

Node inventories are saved in `nodeInventories`, keyed by team, tenancy, compartment and region. `nodeInventoryScopes` stores the configured discovery binding. Each complete snapshot includes fetch time, inventory hash, all discovered nodes and RUNNING eligibility. Failed refreshes preserve the previous successful snapshot for inspection and block its use for remediation. Plan receipts retain each pre-remediation freshness check. OCI credentials remain in the server’s OCI profile, outside this database.
