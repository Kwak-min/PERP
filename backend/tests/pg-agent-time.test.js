import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { briefTaskItems } from "../src/controllers/pgAgent.controller.js";
import { legacyBriefTaskItems } from "../src/controllers/agent.controller.js";

describe("PG briefing Korean business day", () => {
  const tasks = [
    { id: "1", title: "SEP09", due_on: "2026-09-09" },
    { id: "2", title: "SEP10", due_on: "2026-09-10" },
    { id: "3", title: "SEP11", due_on: "2026-09-11" },
  ];

  it("moves the day boundary at midnight Asia/Seoul rather than midnight UTC", () => {
    const before = briefTaskItems(tasks, new Date("2026-09-09T14:59:59.999Z"));
    assert.deepEqual(before.map(item => [item.title, item.kind]), [["SEP09", "today_task"]]);

    const after = briefTaskItems(tasks, new Date("2026-09-09T15:00:00.000Z"));
    assert.deepEqual(after.map(item => [item.title, item.kind]), [
      ["SEP09", "overdue_task"],
      ["SEP10", "today_task"],
    ]);
  });
});


describe("legacy briefing Korean business day and due_at contract", () => {
  it("uses Seoul dates while treating timestamp deadlines as instants", () => {
    const tasks = [
      { id: "d9", title: "DATE09", due_at: "2026-09-09" },
      { id: "d10", title: "DATE10", due_at: "2026-09-10" },
      { id: "past", title: "PAST_INSTANT", due_at: "2026-09-09T14:59:59.999Z" },
      { id: "future", title: "TODAY_FUTURE_INSTANT", due_at: "2026-09-10T05:00:00.000Z" },
    ];
    const before = legacyBriefTaskItems(tasks.slice(0, 2), new Date("2026-09-09T14:59:59.999Z"));
    assert.deepEqual(before.map(item => [item.title, item.kind]), [["DATE09", "today_task"]]);
    const after = legacyBriefTaskItems(tasks, new Date("2026-09-09T15:00:00.000Z"));
    assert.deepEqual(after.map(item => [item.title, item.kind]), [
      ["DATE09", "overdue_task"], ["PAST_INSTANT", "overdue_task"],
      ["DATE10", "today_task"], ["TODAY_FUTURE_INSTANT", "today_task"],
    ]);
  });
});
