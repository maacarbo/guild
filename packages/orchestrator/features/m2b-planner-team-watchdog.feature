Feature: M2b — the planner, the four-role team, and the budget watchdog

  The full application (M2 acceptance, ROADMAP): an operator idea posted as a
  board ticket becomes a staged, gated, contract-validated delivery by the
  fixed four-role starter team — zero un-contracted advances, the decision
  trail queryable — and an induced overspend halts the pipeline cleanly with
  a visible explanation (D12 watchdog).

  Scenario: a demo idea is delivered through five gated stages and an induced overspend halts cleanly
    Given the live stack, the four role agents, and a clean governance database
    When the operator posts the demo idea as a board ticket
    Then the conductor answers with an analysis plan gate awaiting feedback
    When the operator amends the analysis plan with a budget directive
    Then a version-2 analysis gate supersedes the first
    When the operator approves each stage gate and accepts each validated stage
    Then the delivery is complete: main holds the demo product with passing tests and the idea ticket is Done
    And the decision trail records five gated stages with zero un-contracted advances
    When the operator posts a second idea whose analysis is approved and dispatched
    And the budget watchdog sweeps under a one-cent project hard cap
    Then the overspend halts cleanly: work cancelled, dispatch locked, explanation posted
