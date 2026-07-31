/**
 * The ExecutionSubstrate conformance suite bound to the live Tier 1 compose
 * stack (GUILD_LIVE_STACK gates inclusion — vitest.config.ts). This run IS the
 * substrate conformance gate for Multica pin bumps and daemon image rebuilds.
 */

import type { EngagementBrief, WorkItemRef } from "@guild/shared";
import { describeExecutionSubstrateConformance } from "@guild/substrate-conformance";
import { createMulticaSubstrate } from "./index.js";
import { bootstrapLiveEnv, type LiveEnv } from "./testkit/live-env.js";

const trivialBrief: EngagementBrief = {
  roleContext: "You are a conformance probe agent. Your tasks are trivial by design.",
  instructions: "Reply with the single word: ok. Do not create, modify, commit, or push any files.",
  contract: {
    contractId: "conformance-trivial",
    version: 1,
    authoredBy: "conformance-suite",
    gherkin: "Feature: Conformance probe\n  Scenario: reply\n    Then the agent replies ok",
    checks: [],
  },
  priorDecisions: [],
  artifactRefs: [],
  constraints: ["There is nothing to build or push for this task — just reply."],
};

let live: LiveEnv;

describeExecutionSubstrateConformance(async () => {
  live = await bootstrapLiveEnv();
  const apiConfig = { baseUrl: live.baseUrl, token: live.token, workspaceId: live.workspaceId };
  const roleAgents = { worker: { agentId: live.agentId, agentName: live.agentName } };
  return {
    substrate: createMulticaSubstrate(apiConfig, { projectScope: live.workspaceId, roleAgents }),
    projectScope: live.workspaceId,
    role: "worker",
    unknownRole: "astrologer",
    makeSpec: (overrides) => {
      const engagementId = `conf-${crypto.randomUUID().slice(0, 8)}`;
      return {
        engagementId,
        role: "worker",
        title: `conformance probe ${engagementId} (disposable)`,
        brief: trivialBrief,
        ...overrides,
      };
    },
    unauthenticatedSubstrate: () =>
      createMulticaSubstrate(
        { ...apiConfig, token: "mul_invalid_conformance_token" },
        { projectScope: live.workspaceId, roleAgents },
      ),
    listComments: async (ref: WorkItemRef) => {
      const res = await fetch(`${live.baseUrl}/api/issues/${ref.externalId}/comments`, {
        headers: { authorization: `Bearer ${live.token}`, "x-workspace-id": live.workspaceId },
      });
      if (!res.ok) throw new Error(`comments read → ${res.status}`);
      const comments = (await res.json()) as Array<{ id: string; content: string; parent_id: string | null }>;
      return comments.map((c) => ({ id: c.id, body: c.content, inReplyTo: c.parent_id }));
    },
  };
});
