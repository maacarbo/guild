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

  Scenario: A governance ticket is a board-control ticket, not an engagement
    When the conductor creates a governance ticket with a marker id
    Then the marker id round-trips through findWorkItem
    And the ticket has no assigned agent and runs nothing

  Scenario: The lane projection round-trips one-to-one
    When the conductor sets each of the seven lanes on a governance ticket
    Then every lane reads back exactly as set
    And re-setting the current lane is a no-op, never an error

  Scenario: A conductor lane move surfaces as a lane_moved event
    When the conductor moves a ticket to the waiting-for-feedback lane
    Then a lane_moved event arrives over the watch stream
    And it is attributed to the conductor, never to the operator
