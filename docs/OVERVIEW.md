# Guild — Component & Flow Overview

One page that shows every component and every data/event flow between them. Decisions and rationale live in [ARCHITECTURE.md](ARCHITECTURE.md) (D1–D8); this page is the map. Topology shown is the M1–M2 **isolated dev stack** (kubectl-deployed, zero pre-existing services); the M3 promotion changes where things run, not how they talk.

## Components

| # | Component | Runs as | Owns / stores | Trust notes |
|---|---|---|---|---|
| 1 | **Operator** | human | final say: plan approvals, answers, stage acceptance | the only non-automated authority |
| 2 | **Guild CLI** | local binary | — (driving adapter) | talks only to the conductor |
| 3 | **Guild conductor** (`packages/orchestrator`) | K8s Deployment (dedicated dev namespace) | stage planner, approval gate, contract validator, budget watchdog | never trusts agent self-reports (D6) |
| 4 | **Guild Postgres** | in-cluster (dev) or external — dual-mode | stage plans, engagement states, append-only `decisions` (gates, verdicts, budget events) | governance provenance |
| 5 | **`substrate-multica` adapter** | library inside the conductor | translation only — no state | anti-corruption layer (D8): Multica vocabulary stops here |
| 6 | **Multica backend** | K8s Deployment (dev namespace) | REST + WebSocket API; task queue, deterministic comment routing | driven only via the `ExecutionSubstrate` port |
| 7 | **Multica frontend (board)** | K8s Deployment | kanban UI over the backend | operator's *observation* channel; approvals do **not** flow here |
| 8 | **Multica Postgres** (pgvector) | in-cluster (dev) or external — dual-mode | issues, task queue, comments, timeline (execution audit), agent sessions, `task_usage` (cost *recording*) | Multica's system of record |
| 9 | **Multica daemon** | custom container (Guild-built), K8s Deployment; gVisor from M1 if available on the nodes, mandatory by M3 | agent workspaces (PVC); all chosen runtime CLIs baked in; forks the matching CLI per task | executes LLM-generated code — the least-trusted workload; holds only Multica token + git credentials |
| 10 | **Agent CLIs** (claude code, codex, opencode, …) | short-lived subprocesses, one per task — selected by the agent's configured runtime | per-engagement session state (fresh per issue) | model traffic forced through the gateway via base-URL env |
| 11 | **LiteLLM gateway** (isolated dev instance) | K8s Deployment + own DB (virtual keys, per-key spend) | model routing, per-role policy, spend metering — the **enforcement** data source | sole holder of provider API keys |
| 12 | **Model providers** | external APIs (Anthropic; optionally OpenRouter; Ollama as documented option) | — | reached only from the gateway |
| 13 | **Product repo(s)** | git hosting — repo-per-project on the operator's GitHub (OQ3 resolved 2026-07-30) | the generated application: code, contract artifacts (`features/`), branches per engagement | single-writer per branch; merges are Guild-mediated, fast-forward-only to the validated SHA |
| 14 | **Contract validator** | ephemeral K8s Job from the daemon image, spawned per validation | nothing — reads a detached checkout, emits exit codes + evidence | second least-trusted workload: zero Guild credentials, registry-only egress; the conductor writes the verdict |

## System map

```mermaid
flowchart LR
    OP((1 Operator))
    CLI[2 Guild CLI]
    subgraph GD["guild dev namespace (names illustrative)"]
        COND[3 Conductor<br/>planner / gate / validator / watchdog]
        GPG[(4 Guild PG)]
    end
    subgraph MD["multica dev namespace"]
        BE[6 Multica backend]
        FE[7 Board UI]
        MPG[(8 Multica PG)]
        DM[9 Daemon container<br/>10 agent CLIs inside]
    end
    subgraph LD["litellm dev namespace"]
        LLM[11 LiteLLM]
        LDB[(keys + spend)]
    end
    PROV[12 Anthropic / OpenRouter]
    REPO[(13 Product repo)]

    OP -->|ideas, approvals, answers| CLI --> COND
    OP -.->|observes board| FE --> BE
    COND --> GPG
    COND -->|5 adapter: REST create/assign/comment/cancel| BE
    BE -->|WebSocket events| COND
    BE --> MPG
    DM -->|poll, claim, report| BE
    DM -->|clone / push branches| REPO
    DM -->|base-URL env| LLM --> PROV
    LLM --> LDB
    COND -->|reads spend| LLM
    COND -->|clones + validates contracts| REPO
```

Two channels never exist: agents never talk to each other directly (all coordination is Multica issues/comments), and nothing but the gateway ever holds a provider key.

## Where the agents live — provisioning & runtime selection

The system map compresses the agent layer into boxes 9–10; this is what's inside. An "agent" is not a long-running process — it is (a) a **Guild role template**, (b) a **Multica agent registry entry** created from it, and (c) a **short-lived CLI process** the daemon forks per task:

```mermaid
flowchart TB
    RT["Guild role template<br/>role, runtime CLI, model tier,<br/>skills, context brief"]
    ST["Staffing<br/>M1-M2: fixed starter team<br/>M4: demand-driven hiring via API"]
    AG["Multica agent (registry entry)<br/>runtime + model set per agent<br/>Multica supports 14+ CLIs"]
    TQ["task claimed for this agent"]
    DM["Daemon container<br/>all chosen runtime CLIs baked into the image,<br/>auto-detected on PATH"]
    CC["claude CLI"]
    CX["codex CLI"]
    OC["opencode CLI"]
    LLM["LiteLLM gateway<br/>routes by model name, meters spend"]
    RT --> ST --> AG --> TQ --> DM
    DM -->|"spawn per task - fresh session per engagement"| CC
    DM --> CX
    DM --> OC
    CC --> LLM
    CX --> LLM
    OC --> LLM
```

- **Role → runtime → model is data, not code**: want Codex for the implementer and Claude Code for the architect? Two role templates with different `runtime` values; staffing creates two Multica agents; the daemon forks whichever CLI each task's agent specifies. Verified Multica mechanics: agents carry a per-agent runtime + model choice, and the daemon auto-detects installed CLIs.
- **Per-task spawn, not per-agent servers**: nothing idles between engagements; "spinning up an agent" costs a process fork, and context-freshness falls out of it (one issue per engagement, D6/lifecycle above).
- **Adding a runtime = three moves**: install the CLI in the daemon image (`docker/daemon/`), add its provider route to the gateway if it needs one, reference it in a role template. Nothing in the conductor changes — runtime identity never crosses the `ExecutionSubstrate` port.
- **Placement & scale**: multiple daemons can register as separate Multica runtimes (tasks carry a runtime binding — the session-resume gating in the research doc is keyed on it), so heavy roles can get their own daemon Deployment later without design change.
- **Why only LiteLLM showed up as "the gateway"**: it is the *model* layer under every runtime — one policy and one budget regardless of which CLI is doing the work. The *agent* layer is this section.

## Engagement lifecycle (states owned by the conductor, stored in Guild PG)

```mermaid
stateDiagram-v2
    [*] --> Planned
    Planned --> Gated: plan posted to operator
    Gated --> Dispatched: approved (timer only if opted in)
    Dispatched --> Working: daemon claims task
    Working --> Blocked: agent raises question
    Blocked --> Working: answer routed back
    Working --> Reported: agent says done
    Reported --> Validated: contract passes (Guild-run)
    Reported --> Reported: validator_error — validation retried, work never bounced
    Reported --> Bounced: contract fails
    Bounced --> Working: re-dispatched, same issue — self-contained bounce comment (count ≤ MAX_BOUNCES)
    Bounced --> Escalated: bounce limit reached
    Escalated --> [*]: operator cancels or rescopes
    Working --> Cancelled: budget hard cap / operator / stage rejected
    Cancelled --> [*]: key revoked, item closed
    Validated --> Accepted: operator accepts stage
    Accepted --> [*]: key revoked, item closed
```

## Flows

### F1–F2 · Idea → plan → approval gate

```mermaid
sequenceDiagram
    participant OP as Operator
    participant CLI as Guild CLI
    participant C as Conductor
    participant G as Guild PG
    OP->>CLI: submit idea
    CLI->>C: create project
    C->>C: planner: stages, roles,<br/>engagements, budgets
    C->>G: persist StagePlan
    C-->>CLI: plan for approval (explicit by default, timer opt-in)
    CLI-->>OP: present plan
    OP->>CLI: approve / amend
    CLI->>C: gate decision
    C->>G: append gate decision
```

No tokens are spent on execution before this gate — specification defects die here, at their cheapest.

### F3–F4 · Contracted dispatch → execution → metering

```mermaid
sequenceDiagram
    participant C as Conductor
    participant A as substrate-multica
    participant BE as Multica backend
    participant DM as Daemon
    participant CLIs as Agent CLI
    participant LLM as LiteLLM
    C->>A: dispatch engagement
    A->>BE: create issue (brief = role context + instructions + contract + prior decisions + artifacts), assign agent
    DM->>BE: poll, claim task
    DM->>CLIs: fork CLI — new issue ⇒ fresh session (context-fresh by construction)
    CLIs->>LLM: model calls (base-URL env)
    LLM-->>CLIs: completions
    LLM->>LLM: record spend on the engagement's virtual key
    DM->>BE: status + progress comments
    BE-->>A: WebSocket events
    A-->>C: SubstrateEvents (status / comment / usage)
    C->>C: update engagement state
```

### F5 · Question / blocker → answer routing

```mermaid
sequenceDiagram
    participant CLIs as Agent CLI
    participant DM as Daemon
    participant BE as Multica backend
    participant C as Conductor
    participant OP as Operator
    CLIs->>DM: blocked — question in comment
    DM->>BE: set status blocked + comment
    BE-->>C: WS event
    C-->>OP: surface open blocker (CLI), board shows it too
    OP->>BE: reply (board comment)
    BE->>BE: deterministic routing: reply → parent comment's author agent
    BE->>DM: enqueue follow-up task (same agent + issue)
    DM->>CLIs: session resume + reply injected into prompt
```

Routing is Multica's verified server-side mechanism — Guild adds no correlation layer; it only surfaces open blockers and lets work that doesn't depend on the answer continue.

### F6 · Completion → contract validation → advance or bounce

```mermaid
sequenceDiagram
    participant CLIs as Agent CLI
    participant DM as Daemon
    participant BE as Multica backend
    participant C as Conductor
    participant R as Product repo
    participant G as Guild PG
    participant V as Validator Job
    CLIs->>DM: work done (self-report)
    DM->>R: push engagement branch
    DM->>BE: status done
    BE-->>C: WS event
    C->>R: resolve branch head ONCE → commitSha
    C->>V: spawn ephemeral Job (daemon image, zero Guild creds)
    V->>R: detached checkout at commitSha
    V->>V: run checks — Gherkin + commands, per-check timeouts
    V-->>C: exit codes + captured evidence
    C->>G: conductor writes the verdict (validator can fail work, never sign for Guild)
    alt contract passes
        C->>BE: comment verdict, advance
        C->>R: fast-forward-only merge to the validated commitSha
    else contract fails
        C->>BE: bounce — failing criteria commented on the SAME issue
        Note over BE,CLIs: same issue ⇒ session resumes with prior context + failures
    else validator error
        C->>C: retry validation — infrastructure faults never bounce the work
    end
```

The self-report is treated as hostile input (D6): the agent saying "done" starts validation, it never concludes it.

### F7 · Budget watchdog → kill-switch (M3)

```mermaid
sequenceDiagram
    participant LLM as LiteLLM
    participant C as Conductor (watchdog)
    participant A as substrate-multica
    participant BE as Multica backend
    participant OP as Operator
    C->>LLM: read spend per engagement virtual key
    alt soft cap reached
        C->>BE: warning comment on engagement
        C-->>OP: warn
    else hard cap reached
        C->>A: cancel work item
        A->>BE: cancel task
        C->>C: stop dispatching project
        C-->>OP: halted + explanation
    end
```

Multica records cost; only the gateway's numbers can *enforce* it — that is LiteLLM's reason for existing in this architecture.

## Who stores what

| Data | Lives in | Written by | Read by |
|---|---|---|---|
| Stage plans, engagement states, gate decisions, contract verdicts, budget ledger | Guild PG (`decisions` is append-only) | conductor | conductor, operator via CLI |
| Issues, comments, timeline, task queue, agent sessions | Multica PG | Multica backend/daemon | conductor (via WS/REST), operator (board) |
| Cost *recording* per task | Multica PG (`task_usage`) | Multica | optional cross-check only |
| Virtual keys, authoritative spend | LiteLLM DB | gateway | watchdog (enforcement) |
| Generated code, contract artifacts, branches | product repo | agents (one writer per branch), Guild (merges) | validator, downstream roles (trace visibility, D6) |
| Agent workspaces | daemon PVC | daemon/CLIs | daemon |

## Trust boundaries, one line each

- **Operator ↔ Guild**: the only place authority enters; gates and acceptance are theirs.
- **Guild ↔ Multica**: one port (`ExecutionSubstrate`); Multica's vocabulary and Multica's trust in agent self-reports both stop at the adapter.
- **Daemon ↔ everything**: least-trusted (runs generated code); no provider keys; scoped egress + least-privilege from M1, gVisor per the Talos node-image plan (one labeled worker first; cluster-wide at M3).
- **Validator ↔ Guild**: the validator executes agent-authored checks — hostile input — so it is a trust-peer of the daemon (ephemeral Job, zero Guild credentials); it can fail work but never signs for Guild.
- **Gateway ↔ providers**: the only key holder; every model token, in and out, is metered here.
