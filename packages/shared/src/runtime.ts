/**
 * Runtime-adapter contract — every agentic client (Claude Code, OpenCode, …)
 * is wrapped in this interface (see ARCHITECTURE.md D3).
 */

import type { GuildEvent } from "./events.js";

/**
 * Capabilities selected for an agent at provision time, filtered by role fit.
 * Entries are runtime-neutral; each adapter maps them to its native mechanisms
 * (Claude Code hooks, OpenCode plugins, …) per its M3 capability mapping table.
 */
export interface CapabilityManifest {
  skills: string[];
  mcpServers: string[];
  automations: string[];
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

/**
 * Serializable — must survive persistence and process restarts, enabling
 * suspend/resume of Waiting agents and crash recovery (M5 Job economics).
 */
export interface AgentHandle {
  agentId: string;
  runtime: string;
  /** the runtime's own session identifier (Claude SDK session, OpenCode server session) */
  nativeSessionId: string;
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

export interface PermissionDecision {
  allowed: boolean;
  note?: string;
}

export interface AgentRuntimeAdapter {
  readonly name: string;
  provision(spec: AgentSpec): Promise<AgentHandle>;
  run(handle: AgentHandle, assignment: TaskAssignment): AsyncIterable<GuildEvent>;
  deliverAnswer(handle: AgentHandle, answer: Answer): Promise<void>;
  /** reply path for agent.permission_requested events (Claude SDK canUseTool, OpenCode permissions endpoint) */
  respondToPermission(handle: AgentHandle, requestId: string, decision: PermissionDecision): Promise<void>;
  /** stop current work without destroying the agent; distinct from retire() */
  interrupt(handle: AgentHandle, taskId?: string): Promise<void>;
  retire(handle: AgentHandle): Promise<void>;
}
