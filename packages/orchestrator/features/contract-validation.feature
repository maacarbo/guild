# Scenarios for the D6 contract validator, executed by
# src/domain/verdict.test.ts + src/application/contract-validator.test.ts
# (unit) and src/validator.live.test.ts (docker-run driver, live).
# Traces to ROADMAP M1b: "first proof of the core mechanism".

Feature: Handoff contract validation
  The upstream role authors acceptance criteria before implementation; Guild
  validates the reported work in a conductor-controlled sandbox — a fresh
  clone pinned to the reported commit, never the daemon's workspace, never
  the implementer's self-report.

  Scenario: Work that meets the contract validates
    Given a hand-written contract for the engagement
    And the agent reported a commit
    When the validator checks out exactly that commit in a fresh clone
    And every check passes in the least-trusted sandbox
    Then the verdict is passed and records the pinned commit

  Scenario: Work that misses a criterion bounces
    When any check fails in the sandbox
    Then the verdict is failed and carries the failing checks with evidence

  Scenario: Infrastructure faults never bounce the work
    When the clone or a check cannot be executed at all
    Then the verdict is a validator error and validation is retried

  Scenario: The sandbox is least-trusted
    # egress denial and timeout containment execute live (validator.live.test.ts);
    # the no-credentials clause holds by construction — the driver hands the
    # container only the clone bind-mount, never an env or credential surface
    Then checks run with no credentials and no network egress
    And a check timeout is an acceptance failure, not an infrastructure fault
