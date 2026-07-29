/**
 * Runtime-adapter contract — every agentic client (Claude Code, OpenCode, …)
 * is wrapped in this interface (see ARCHITECTURE.md D3).
 */

import type { GuildEvent } from "./events.js";

/** Capabilities selected for an agent at provision time, filtered by role fit. */
export interface CapabilityManifest {
  skills: string[];
  mcpServers: string[];
  hooks: string[];
}

export interface AgentSpec {
  projectId: string;
  role: string;
  /** role template + project context, composed into the runtime's context file (AGENTS.md / CLAUDE.md) */
  contextMarkdown: string;
  capabilities: CapabilityManifest;
  /** model assignment from the per-role model policy, resolved via the LiteLLM gateway */
  model: string;
  workspacePath: string;
}

export interface AgentHandle {
  agentId: string;
  runtime: string;
}

export interface TaskAssignment {
  taskId: string;
  title: string;
  instructions: string;
  dependsOnSummaries: Record<string, string>;
}

export interface Answer {
  questionId: string;
  answer: string;
}

export interface AgentRuntimeAdapter {
  readonly name: string;
  provision(spec: AgentSpec): Promise<AgentHandle>;
  run(handle: AgentHandle, assignment: TaskAssignment): AsyncIterable<GuildEvent>;
  deliverAnswer(handle: AgentHandle, answer: Answer): Promise<void>;
  retire(handle: AgentHandle): Promise<void>;
}
