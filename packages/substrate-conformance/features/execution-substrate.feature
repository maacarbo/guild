# Scenarios for the ExecutionSubstrate port contract (D8). Executed by the
# conformance suite in src/index.ts (vitest, against the live Tier 1 stack);
# each scenario name maps 1:1 to a suite test. Traces to ROADMAP M1b.

Feature: Execution substrate conformance
  Guild's conductor drives any execution substrate through one port. An
  adapter that passes these scenarios can carry engagements: dispatch is
  idempotent, cancellation is safe to retry, bounces reach the implementing
  agent, faults classify into stable categories, and a completed engagement
  yields a work report the validator can pin to a commit.

  Scenario: Dispatch is idempotent
    When the conductor creates a work item for an engagement
    Then finding a work item by that engagement id returns the same work item
    And finding a work item for a never-dispatched engagement returns nothing

  Scenario: A fresh work item is assigned and pending
    When the conductor creates a work item for an engagement
    Then its snapshot shows an assigned agent and a non-terminal status

  Scenario: The project scope lists only substrate-owned work items
    When the conductor lists work items in the project scope
    Then every listed item belongs to this substrate

  Scenario: Cancellation is effective and safe to retry
    When the conductor cancels a fresh work item
    Then the work item reaches a terminal status
    And cancelling it again is a no-op, never an error

  Scenario: Comments post top-level and thread on request
    When the conductor comments on a work item
    And replies to that comment
    Then the reply is threaded under the original comment

  Scenario: A bounce delivers the failing criteria to the implementing agent
    When contract validation fails and the conductor requests rework
    Then a top-level comment carries the failing checks and their evidence

  Scenario: Closing a work item is advisory bookkeeping
    When the conductor closes a cancelled work item
    Then the work item remains readable

  Scenario: Faults classify into stable categories
    Then bad credentials classify as an auth fault
    And a missing work item classifies as not found
    And an unbound role classifies as an unsupported capability

  Scenario: An agent completes a work item
    When the conductor creates a work item and an agent completes it
    Then status events for the item arrive over the watch stream with unique event ids
    And the final snapshot is done and carries a work report with a branch hint
