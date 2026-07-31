import { describe, expect, it } from "vitest";
import { substrateEventFromFrame } from "./events.js";

// fixtures are verbatim frames captured live 2026-07-31 (M1b WS probe)
const queued = {
  type: "task:queued",
  payload: {
    agent_id: "3467ba83-ae9f-48a5-8b4a-cd83346d153f",
    issue_id: "c7e23f5a-b1b6-4c55-b2cd-cdecc98e5566",
    status: "queued",
    task_id: "1f3a5683-7c55-4564-a644-9882e1633d84",
  },
};
const dispatch = {
  type: "task:dispatch",
  payload: {
    agent_id: "3467ba83-ae9f-48a5-8b4a-cd83346d153f",
    issue_id: "c7e23f5a-b1b6-4c55-b2cd-cdecc98e5566",
    runtime_id: "7cbfb765-6edc-45d5-bbb1-e5a50e677f9f",
    task_id: "1f3a5683-7c55-4564-a644-9882e1633d84",
  },
};
const failed = {
  type: "task:failed",
  payload: {
    agent_id: "3467ba83-ae9f-48a5-8b4a-cd83346d153f",
    issue_id: "c7e23f5a-b1b6-4c55-b2cd-cdecc98e5566",
    status: "failed",
    task_id: "1f3a5683-7c55-4564-a644-9882e1633d84",
  },
};
const commentCreated = {
  type: "comment:created",
  payload: {
    comment: {
      id: "6f42dda9-4713-4b66-99c3-7663d388e5e7",
      issue_id: "c4db0005-9286-4e71-8f29-d0f7396295ec",
      author_type: "member",
      author_id: "7e3fa62b-f769-4c66-8204-83d821c2be48",
      content: "ws frame probe comment",
      type: "comment",
      parent_id: null,
      created_at: "2026-07-31T11:04:13Z",
    },
  },
};

const at = "2026-07-31T11:04:14Z";

describe("substrateEventFromFrame", () => {
  it("translates task state frames to status events on the owning work item", () => {
    const e = substrateEventFromFrame("multica", queued, at);
    expect(e).toEqual({
      kind: "status",
      item: { substrate: "multica", externalId: "c7e23f5a-b1b6-4c55-b2cd-cdecc98e5566" },
      status: "queued",
      at,
    });
  });

  it("translates task:dispatch (no payload.status) to a queued status event", () => {
    const e = substrateEventFromFrame("multica", dispatch, at);
    expect(e).toMatchObject({ kind: "status", status: "queued" });
  });

  it("translates terminal task frames", () => {
    expect(substrateEventFromFrame("multica", failed, at)).toMatchObject({
      kind: "status",
      status: "failed",
    });
  });

  it("translates comment:created with the comment's own timestamp and author", () => {
    const e = substrateEventFromFrame("multica", commentCreated, at);
    expect(e).toEqual({
      kind: "comment",
      commentId: "6f42dda9-4713-4b66-99c3-7663d388e5e7",
      item: { substrate: "multica", externalId: "c4db0005-9286-4e71-8f29-d0f7396295ec" },
      author: "7e3fa62b-f769-4c66-8204-83d821c2be48",
      body: "ws frame probe comment",
      at: "2026-07-31T11:04:13Z",
    });
  });

  it("ignores frames Guild does not consume (auth_ack, activity, inbox, agent:status…)", () => {
    for (const type of ["auth_ack", "activity:created", "inbox:new", "agent:status", "issue:updated"]) {
      expect(substrateEventFromFrame("multica", { type, payload: {} }, at)).toBeNull();
    }
  });

  it("surfaces an unknown task state as an unknown-status event, never a guess (D8)", () => {
    const e = substrateEventFromFrame(
      "multica",
      { type: "task:hibernated", payload: { issue_id: "i", task_id: "t", status: "hibernated" } },
      at,
    );
    expect(e).toMatchObject({ kind: "status", status: "unknown" });
  });
});
