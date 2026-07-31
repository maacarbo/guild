# The M1 acceptance bar (ROADMAP M1b exit criteria), executed by
# features/steps/m1-smoke.steps.ts via `pnpm smoke`. One idempotent run over
# standing infrastructure: assumes the Tier 1 compose stack is up, assumes no
# prior test state, and must pass twice consecutively without a reset.

Feature: M1 — the substrate is proven
  A governed engagement crosses the execution substrate end to end: dispatched
  through the port, worked by a containerized agent whose model traffic is
  metered on its own budget-capped virtual key, delivered as a branch in the
  scratch repository, observed over the event stream, and judged by a handoff
  contract validated against the pinned commit in the least-trusted sandbox.

  Scenario: A governed engagement crosses the substrate end to end
    Given the Tier 1 stack is healthy
    And a per-engagement virtual key with a 50-cent budget
    When the conductor dispatches the engagement through the substrate port
    Then the agent completes the work item
    And status events for the work item arrived over the watch stream
    And the engagement branch lands in the scratch repository
    And the handoff contract validates against the pinned commit
    And the spend is attributed to the engagement's virtual key
    And the engagement terminates cleanly
