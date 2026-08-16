# Scenarios for M3 team evolution (D16 hiring, role memory, template
# catalog, advisory riders), executed by src/application/conductor.test.ts
# and src/domain/templates.test.ts (unit; the live proof is the M3
# acceptance recorded in ROADMAP — two quick-fix runs on the Tier 1 stack,
# 2026-08-12). Backfilled 2026-08-16 (conformance audit bdd-2): the
# behaviors shipped with vitest coverage but no Gherkin, which the BDD rule
# requires. Traces to ROADMAP M3: the acceptance bar (hiring, retirement,
# role memory, decision provenance) and the milestone's deliverable bullets
# (template catalog, D12 amendment; advisory riders, D13 amendment #29).

Feature: Team evolution
  The plan demanding a role IS the hiring signal: Guild hires agents on
  demand from role templates, remembers what each role accepted, retires the
  team when the run completes, and records every hire and retire in the
  append-only decision trail.

  Scenario: A role the plan demands but nobody holds is hired at dispatch
    Given an approved stage plan demanding a role no agent holds
    When the engagement dispatches
    Then an agent is hired for the role from its role template
    And a hire decision with the run's plan id is appended to the trail

  Scenario: An already-held role hires nothing
    Given an approved stage plan demanding a role an agent already holds
    When the engagement dispatches
    Then no new agent is hired and no hire decision is appended

  Scenario: A completed run retires the roles it hired
    Given a run whose every stage is accepted
    When the run completes
    Then each role hired for this run is retired exactly once
    And retire decisions are appended, idempotently across reconciles

  Scenario: Role memory carries acceptances to the next engagement
    Given a role that accepted work at a validated commit
    When a later stage briefs the same role
    Then the brief's prior decisions carry the acceptance line
    And the role-memory artifact stays bounded to its newest lines

  Scenario: The template directive shapes the plan run
    Given an idea whose body carries a template directive
    When the idea is adopted
    Then the run's stages follow the named template with the standard as default
    And an unknown template name degrades to standard with a warning at the gate

  Scenario: Same-kind stages coexist under distinct slugs
    Given an enterprise idea with two analysis-kind stages
    When both stages gate and complete
    Then each posts a distinctly-titled approval gate keyed on its slug
    And role memory attributes each acceptance to the stage's slug

  Scenario: An advisory rider observes without gating
    Given a stage plan carrying an advisory engagement beside its worker
    When the worker's acceptance completes the stage
    Then the stage completes on the non-advisory acceptance alone
    And the rider is cancelled at stage end through the spend-capturing path
    And the rider's reports are never contract-judged
