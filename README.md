# Orbit — Specialist Agent Operations

**Dedicated team workspaces for governed agent workflows.**

Orbit is an MVP where teams operate specialist agents, run workflows, review approvals, and track outcomes. It includes ten executable specialist workflows based on the architecture diagrams in `docs/`. The dashboard, team workspaces, agent registry, approvals, task routing, audit events and workflow checkpoints share a persistent JSON store.

The leadership proposal is to complement Oracle’s enterprise AI program with team operations and workflow execution. Alignment with GCGA and enterprise governance is proposed and still needs validation; this MVP does not establish enterprise approval or a production integration.

## Run

Requires Node.js 20 or newer. No dependencies need to be installed.

```bash
npm start
```

Open [the command center](http://localhost:8000) or [the agent workspace](http://localhost:8000/workflows.html). Use `PORT` to change the port and `ORBIT_STORE_PATH` to use a separate JSON database. Stop with Ctrl+C.

## Try a workflow

1. Open **Agent workspace** from the command center, agent registry or team navigation.
2. Choose a team and specialist, review its configured demo target, then edit its inputs and create a plan.
3. The plan starts automatically and saves a receipt after every step. A change workflow pauses at its human approval gate.
4. To try approval as the local demo user, add **Michael Kabongo** to the chosen team’s designated approvers in its Governance section. Return to the workspace, refresh, inspect the plan and approve it.
5. After approval, execution continues automatically through verification. Incident triage also requires explicit customer confirmation with evidence. TLS promotion records the active certificate and next renewal due date.
6. Try **Pause**, **Reconcile & resume**, or **Simulate a step failure** while paused. Execution continues when the browser closes and resumes at the saved checkpoint after a server restart. Pause, approval waits, customer waits and failures remain paused. Older saved plans have a one-time **Run plan** action. Stop releases the simulated target lock.

A governed request from the dashboard or a team automatically selects a permitted specialist and creates the same executable plan. Infrastructure changes require approval even when a caller labels the request low risk. Dedicated agents retain their existing registration flow; they need a registered runtime adapter before invocation.

## Implemented specialists

| Agent | MVP workflow |
| --- | --- |
| Vulnerability Remediation (`oke-vulnerabilities`) | Vendor finding intake, exact-plan approval, canary-first serial preflight/drain/patch/reboot/recovery/restore/stability, fresh rescan |
| APEX Vulnerabilities | Finding assessment, source proposal, approval, deployment and verification |
| OKE Cluster Provisioning | Inventory, source proposal, approval, deployment and desired-state verification |
| Cluster & Nodepool Upgrade | Inventory, source proposal, approval, canary upgrade and verification |
| Ticket Management | Read-only ticket classification, owner routing and response preparation |
| TLS Certificate Management (`tpls-management`) | Saved binding, certificate candidate, validation, source proposal, approval, deployment, served TLS verification, active promotion and renewal scheduling |
| Notification | Tenant-scoped message preparation and simulated outbox receipt |
| APEX Troubleshooting | Read-only evidence, runbook match and recovery recommendation |
| OKE Troubleshooting | Read-only evidence, runbook match and recovery recommendation |
| Incident Triage | Ticket triage, runbook, diagnosis, source proposal, approval, deployment, recovery, customer confirmation and RCA/closure |

The first nine come from `docs/Platform Governance Architecure Flow.png`. Incident triage comes from `docs/Incident-triage-agent.png`. The expanded vulnerability and certificate workflows follow `docs/Vulnerability-agent-architecture.png` and `docs/TLS-Agent-Architecture.png`. The existing `tpls-management` ID is preserved for compatibility.

## Governance and persistence

Plans include the versioned MVP runbook, team target, input, ordered steps, simulation mode and SHA-256 hash. Approval requires a designated team approver and the exact plan hash. Each action requires the current revision; stale tabs cannot advance or approve a newer checkpoint. Scope changes, removed agents and tool restrictions block further execution.

Team configuration holds the target tenancy, region, cluster, namespace, repository, source path allowlist, node inventory and permitted tools. Workflow APIs require matching organization scope. Mutating workflows share a persisted cluster target lock; this MVP deliberately serializes overlapping maintenance and deployments. Read-only diagnostics can continue. Failed steps retain the lock and prevent later steps or nodes from running.

TLS renewal reuses the saved hostname and Secret name. The existing active certificate remains unchanged until the candidate completes simulated deployment and verification. Renewal is due 30 days before the active certificate’s expiry. On startup and every minute, the server queues due renewal plans with fresh approval requirements. In-flight plans are deduplicated; a stopped scheduled renewal is not repeatedly recreated for the same active fingerprint. Operators can create a new renewal manually. Newly created plans run automatically up to their approval gate. Scheduler errors are recorded once per changed error.

The server atomically replaces `data/store.json` after each mutation. Workflow receipts and approval records remain in that database across restarts. Browser assets are explicitly allowlisted so backend source and the database are not served as static files. Existing legacy demo tasks remain visible; they have no real execution evidence.

## MVP boundaries

All external tool operations use deterministic **simulation adapters**. This MVP runs the workflow orchestration, approval and persistence logic; it does not call an LLM, retrieve live knowledge, create real PRs, patch nodes, issue cryptographically valid certificates, deploy resources, send messages or update Jira. Simulated tool receipts explicitly identify this mode. Certificate state contains metadata and simulated vault references, never private keys.

Identity is a fixed local demo administrator. `/api/state` is an administrator snapshot across teams; organization checks on workflow routes do not replace authenticated multi-tenant authorization. Before using real infrastructure, add SSO/RBAC, identity-derived tenant scope, scoped provider adapters, real evidence and CI/merge verification, a credential broker, transactional storage and distributed execution ownership. The current file store supports one server process and automatic checkpoint execution. Dashboard cost/trust figures remain seeded demo metrics.

## Jira ticket-created automation

Each team can add multiple independent connections in **Team Jira connections**. Each connection saves its own Jira URL, project, queue names, ticket intake type and optional description. Use **Add Jira connection** to add another site; editing one connection preserves the others. Settings persist independently for each team. Queue names and descriptions identify the team’s queues; event filtering still uses the project, optional label and Jira Automation condition. The agent workspace includes received tickets, their triage run, specialist work and owner-review status. **Simulate ticket created** demonstrates the complete local flow without creating an issue in Jira.

The configured source projects are:

| Team | Jira source | Intake type |
| --- | --- | --- |
| EE Orchestration | `https://jira.oraclecorp.com/jira`, project `EEOKE` | Service requests |
| EE Orchestration | `https://jira-sd.mc1.oracleiaas.com`, project `EEORCH` | Incidents |

These mappings are saved independently; live delivery needs a Jira-reachable HTTPS address and each connection’s configured webhook secret. Saving a URL or queue does not require a secret. The page shows **saved connection** status separately from live delivery readiness. This secret authenticates incoming events to the governance server; it is not a Jira login or Jira API token. Jira ticket URLs identify the source; they are not webhook receiver addresses. A project mapping accepts all new issues in that project unless a queue label or the Jira rule’s queue condition narrows it.

When a matching created-ticket event arrives, the Ticket Management Agent runs automatically, prepares a classification and owner recommendation, then starts a supported diagnostic specialist. The incident queue always routes to Incident Triage. Missing remediation versions, certificate bindings or change targets go to owner review instead of guessed changes. Handoff is durable, and repeated deliveries remain deduplicated after the triage run completes or the server restarts. Existing historical issues are not automatically imported.

For live delivery, configure each project’s Jira Automation rule:

1. Trigger on **Issue created** and apply the intended queue condition. Use `project = EEOKE` or `project = EEORCH` when the entire project is the queue.
2. Use **Send web request**, POST, with `Content-Type: application/json` and a hidden `Authorization: Bearer <connection-secret>` header. The [Atlassian automation action documentation](https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/) describes outgoing requests; [Data Center guidance](https://support.atlassian.com/jira/kb/how-to-pass-a-custom-header-in-a-webhook-request/) covers custom headers.
3. Send to the deployed governance address plus `/api/integrations/jira/<team-id>/<connection-id>/issue-created`. The local app is not reachable from the Jira servers by itself.
4. Set a distinct server environment secret of at least 32 characters for each connection, using its environment variable name shown in **Live event delivery setup**. Values stay outside the JSON database and are never returned by the API.
5. Enable **live webhook intake** in that connection after deploying the receiver and configuring the token.

The accepted body is a Jira-created event. Use the matching Jira site in `issue.self`:

```json
{
  "webhookEvent": "jira:issue_created",
  "issue": {
    "key": "EEOKE-NEW_NUMBER",
    "self": "https://jira.oraclecorp.com/jira/rest/api/2/issue/ISSUE_ID",
    "fields": {
      "project": { "key": "EEOKE" },
      "summary": "The new ticket summary",
      "description": "Optional description",
      "labels": []
    }
  }
}
```

Replace the example issue number and ID with the actual Jira issue. In a custom Automation body, use `{{issue.key}}`, `{{issue.id}}`, `{{issue.project.key}}` and JSON-encoded summary/description smart values. [Atlassian’s JSON functions](https://confluence.atlassian.com/automation072/json-functions-1056675825.html) document `asJsonString` and list encoding. The receiver supports string and ADF descriptions up to 16,000 characters; the triage plan uses a flagged 1,000-character excerpt. The event body is limited to 512 KB.

Incoming events require an enabled connection, its webhook secret, matching project, matching site and optional queue label. API response 202 means a new ticket was accepted; 200 means a duplicate or irrelevant event was acknowledged. The local configuration/demo routes use the MVP’s existing demo administrator boundary, and need real authentication before deployment. Receiving a real event does not make downstream adapters live: diagnoses, recovery, Jira replies, assignment and resolution remain simulated.

## Vulnerability compartment node inventory

In each team workspace, open **Tenancies & compartments**, check the tenancies used by that team, and add one or more compartment names and OCIDs under each. **Save team tenancies** persists the selection independently for that team and creates live inventory scopes for configured server profiles. **Load from OCI** can populate the compartment names/IDs. Missing profiles can be selected and saved pending setup; their live scopes are created when the settings are saved after profile setup. Deselecting a tenancy or compartment blocks future discovery/remediation through its previous live scope while preserving history. Select **Vulnerability Remediation Agent** in Agent workspace to use the saved scopes or configure simulation scopes. Each scope identifies a tenancy, compartment, region and discovery provider. The known tenancy choices are Devapp, prodapp, oragitd, internalnonprod, internalprod, externalnonprod and externalprod. The UI resolves only tenancy IDs, profile names and regions from matching server OCI profiles; credentials are never returned or saved in application state. Missing profiles are labeled as needing setup.

Choose a tenancy and select **Load tenancy compartments** to retrieve its active compartments. Save the chosen compartment scope, then use **Fetch updated nodes**, or create a plan to fetch automatically. Scope definitions and the latest complete node list are persisted in `data/store.json` as `nodeInventoryScopes` and `nodeInventories`. Inventory records are keyed by team, tenancy, compartment and region and contain node identity, name, lifecycle state, image/shape metadata, successful fetch time, content hash and recent fetch history. Stopped/terminated resources remain in inventory; only RUNNING nodes enter remediation plans.

Simulation scopes read their configured demo fleet. Live read-only discovery uses the server’s existing OCI CLI profile, including security-token authentication when that profile references a session token. It reads only profile identity/region/auth-mode metadata into the app; token/key contents and paths are never returned. It verifies the compartment’s parent chain belongs to the requested tenancy, then runs [OCI Compute instance list](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/compute/instance/list.html) with `--all` for pagination. It lists Compute instances in the selected compartment/region, rather than inferring nodes from names or only taking one response page. The [OCI IAM compartment list](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/iam/compartment/list.html) command supplies the compartment picker. This does not recursively inventory instances in child compartments or other regions; configure additional scopes for them. Set `ORBIT_OCI_CLI_PATH` if the server cannot find `oci`.

The approved plan snapshots the inventory hash and discovered node IDs. Before every node preflight, drain, package patch, reboot or service restore, the server re-fetches the complete list. A discovery failure, incomplete response, changed scope, added/removed node or changed relevant node metadata prevents remediation from proceeding. A failed refresh retains the last successful snapshot for inspection, but that snapshot cannot authorize execution. Inventory drift requires stopping the old plan and creating a new one for fresh approval; new nodes are never silently added to an approved plan. Every guarded step records its successful refresh ID/time in its simulated receipt. Compartment ownership locks also coordinate jobs across teams targeting the same physical fleet.

Old vulnerability plans that predate scope inventory require a new plan. Discovery can be live, while patch/drain/reboot adapters remain simulated in this MVP. Provider/CLI tests use mocked OCI responses, not real cloud changes.

## Verification

```bash
npm test
```

The dependency-free tests cover all ten workflows, API integration, exact-plan approval, stale revisions, node/tool/source restrictions, restart checkpoints and locks, injected failures, serial node ordering, customer waits, TLS candidate promotion and renewal scheduling.

An optional browser smoke script checks navigation, TLS completion, checkpoint reload, mobile overflow and escaped input. With Playwright available and Google Chrome installed:

```bash
node tests/browser-smoke.cjs
```

## Main files

- `agent-runtime.js` — specialist definitions, planner, workflow state machine, simulation adapters and renewal planner
- `server.js` — APIs, request routing, scheduler, audit and atomic persistence
- `workflows.html`, `workflows.js`, `workflows.css` — agent workspace
- `agents.*`, `team.*`, `app.js`, `index.html` — registry, team and command center integration
- `tests/` — runtime/API verification and optional browser smoke check

Older single-Jira settings migrate to the team’s first connection; the original team-only webhook URL remains an alias for that first connection. New connections have independent IDs, URL bindings, webhook paths and secrets. Ticket-created demos let you select which saved Jira connection to use.
