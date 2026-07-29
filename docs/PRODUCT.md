# Guild — Product Specification

**Guild** is a collaboration-first multi-agent platform: you submit a product idea, and Guild assembles a team of specialist AI agents that carries it through the enterprise software development lifecycle — business analysis → requirements → architecture → implementation → testing → deployment — ending in a production application runnable on Kubernetes.

The name reflects the core metaphor: a guild of specialists, hired into a team as the work demands, the way an enterprise staffs a project.

## Problem

Single-agent coding tools are strong at bounded tasks but degrade on long-horizon product work: context overflows, no separation of concerns, no institutional structure. Human enterprise teams solved this long ago with specialist roles, staged delivery, and explicit communication channels. Guild applies that structure to AI agents while keeping the human in the loop as product owner — not as babysitter.

## Personas

| Persona | Needs |
|---|---|
| **Product Owner** (primary) | Submit an idea, watch progress on a board, answer agent questions quickly, review and accept deliverables. Does not want to micromanage agents. |
| **Platform Operator** | Deploy Guild on Kubernetes, configure model backends and budgets, register agent runtimes, monitor cost and health. |
| **Team Extender** (later) | Author new role templates, skills, and MCP server integrations that agents can adopt. |

## Core Flows

### 1. Idea intake
The Product Owner submits an idea (free text) in the UI. The orchestrator creates a project, plans the delivery stages, and kicks off the first stage with a business-analyst agent that turns the idea into requirements and acceptance criteria.

### 2. Staffing ("hiring")
At each stage the orchestrator consults the **role registry** and hires the specialists the stage demands — business analyst, architect, implementer, tester, DevOps, and so on. Each agent is provisioned with:

- a composed context file (`AGENTS.md`) built from its role template plus project context,
- the **skills, MCP servers, and hooks** that best fit its role, selected from a capability catalog at creation time,
- a model assignment from the per-role model policy (capability tier vs. cost).

### 3. Execution on the board
Work is decomposed into tasks that flow across a kanban board: **To Do → In Progress → Review → Done**. Agents claim tasks, emit progress events, and hand results to the next role. The board is a live projection of the event stream — the Product Owner always sees true state.

### 4. Questions & answers
Any agent can post a question with its context to the **question feed**. The Product Owner answers in the UI; the answer is routed back to the exact agent that asked (correlation-id based). An open question blocks only the tasks that depend on it — the rest of the team keeps working.

### 5. Delivery
The pipeline ends with a deployable application: source in a repository, tests passing, container images, and Kubernetes manifests. "Done" means the app runs in a cluster, not that code exists.

### 6. Team evolution
The team is not static. Demand signals (queue depth per role, stage transitions, recurring question topics) trigger hiring of additional or new specialist roles, and idle agents are retired — mirroring enterprise staffing best practice. New roles come from the role-template registry.

## MVP Cut

**In (Milestones M1–M2):**

- One project at a time, triggered end to end
- Fixed starter team: business analyst, architect, implementer, tester
- One agent runtime: Claude Code (headless, via the Claude Agent SDK)
- All model access through a LiteLLM gateway (native providers, Ollama, OpenRouter behind one interface)
- Event-driven core on NATS JetStream; task board projected to Postgres
- Web UI: kanban board + question feed with live updates
- Runs locally via docker-compose

**Out (deferred to M3+):**

- Additional runtimes (OpenCode, others) — M3
- Automatic team evolution / hiring policy — M4 (roles are configured manually until then)
- Agents as Kubernetes Jobs, Helm chart, observability — M5
- Multi-project concurrency, RBAC/SSO, budgets, audit — M6

## Non-Goals

- Guild is not a general chat product; every interaction is anchored to a project and its board.
- Guild does not replace the Product Owner's judgment — acceptance stays human.
- No custom model training or fine-tuning; Guild orchestrates existing models.

## Success Criteria

1. A non-trivial demo idea (e.g. "a URL shortener with auth and usage stats") goes from submission to a deployed, tested app on Kubernetes with the Product Owner only answering questions and accepting stages.
2. The same flow completes with at least two different agent runtimes and three model backends (M3).
3. During a run, the system hires a role that was not part of the starting team because demand appeared (M4).
