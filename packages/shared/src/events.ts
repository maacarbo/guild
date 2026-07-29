/**
 * Guild event contracts — the system of record flows over these (see ARCHITECTURE.md D1/D4).
 * Subjects follow `guild.<projectId>.<domain>.<event>`.
 */

export type ActorId = { kind: "agent"; agentId: string } | { kind: "user" };

export interface EventEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  /** schema version; additive changes preferred, consumers upcast on breaking changes */
  version: number;
  projectId: string;
  /** id of the event that caused this one */
  causationId?: string;
  /** groups a request/response exchange, e.g. question → answer, permission request → decision */
  correlationId?: string;
  occurredAt: string;
  actor: ActorId;
  payload: TPayload;
}

export type TaskState = "todo" | "in_progress" | "review" | "done";

export type TaskCreated = EventEnvelope<
  "task.created",
  { taskId: string; title: string; role: string; dependsOn: string[] }
>;
export type TaskClaimed = EventEnvelope<"task.claimed", { taskId: string }>;
export type TaskMoved = EventEnvelope<"task.moved", { taskId: string; from: TaskState; to: TaskState }>;
export type TaskDone = EventEnvelope<"task.done", { taskId: string; summary: string }>;

export type QuestionAsked = EventEnvelope<
  "qa.asked",
  { question: string; context: string; blocksTaskIds: string[] }
>;
export type QuestionAnswered = EventEnvelope<"qa.answered", { answer: string }>;

export type AgentHired = EventEnvelope<"agent.hired", { agentId: string; role: string; runtime: string; model: string }>;
export type AgentProgress = EventEnvelope<"agent.progress", { agentId: string; taskId: string; note: string }>;
export type AgentRetired = EventEnvelope<"agent.retired", { agentId: string; reason: string }>;

/** outward-facing or policy-gated action; requires a reply via AgentRuntimeAdapter.respondToPermission */
export type PermissionRequested = EventEnvelope<
  "agent.permission_requested",
  { agentId: string; requestId: string; action: string; taskId?: string }
>;
export type PermissionDecided = EventEnvelope<
  "agent.permission_decided",
  { agentId: string; requestId: string; allowed: boolean; note?: string }
>;

export type GuildEvent =
  | TaskCreated
  | TaskClaimed
  | TaskMoved
  | TaskDone
  | QuestionAsked
  | QuestionAnswered
  | AgentHired
  | AgentProgress
  | AgentRetired
  | PermissionRequested
  | PermissionDecided;

export const subjects = {
  task: (projectId: string, event: string) => `guild.${projectId}.task.${event}`,
  qa: (projectId: string, event: string) => `guild.${projectId}.qa.${event}`,
  agent: (projectId: string, event: string) => `guild.${projectId}.agent.${event}`,
  agentInbox: (projectId: string, agentId: string) => `guild.${projectId}.agent.${agentId}.inbox`,
} as const;
