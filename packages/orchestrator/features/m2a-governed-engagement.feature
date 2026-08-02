Feature: M2a — one real engagement, governed
  The core governance loop on the live Tier 1 stack: board gate, saga
  dispatch, SHA-pinned validation, a genuine bounce with a real fix,
  fast-forward merge, and the termination protocol — with the conductor
  killed mid-engagement and its replacement recovering purely from reads.
  The first attempt is a real hollow completion (the agent reports done
  with nothing pushed — the multica#1579 failure class); the rework is a
  real second push by the same agent, driven only by the bounce comment.

  Scenario: A governed engagement survives a conductor restart and a genuine bounce
    Given the live stack, a governed workspace, and a hand-authored stage plan
    When the conductor posts the stage for approval
    And the operator approves the plan by moving the gate ticket to Ready to work
    Then the conductor dispatches the engagement with a budget-capped key
    When the conductor is killed mid-engagement and a fresh conductor takes over from reads
    Then the hollow first report fails validation and bounces with the failing criteria
    And the agent's rework validates cleanly at a pinned commit
    When the operator accepts by moving the engagement ticket to Done
    Then the target branch fast-forwards to exactly the validated commit
    And the decision trail records the complete governed lifecycle
