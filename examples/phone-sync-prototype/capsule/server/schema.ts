import { boolean, id, number, string, table, userId } from "lakebed/server";

// C1 tables. Indexes are not unique: every singleton read goes through store.ts take(2).
// Complex values (normalized request, receipt, parents) are bounded JSON strings.
const scope = { ownerId: userId(), dashboardId: string(), questionId: string(), field: string() };
export const schema = {
  memberships: table({ ownerId: userId(), dashboardId: string(), active: boolean() })
    .index("by_owner_dashboard", ["ownerId", "dashboardId"]),
  heads: table({ ...scope, revision: number(), canonicalEventId: id("events").optional(),
    clearedThrough: number(), pendingCount: number() })
    .index("by_scope", ["ownerId", "dashboardId", "questionId", "field"]),
  events: table({ ...scope, deviceId: string(), opId: string(), seq: number(), normalizedRequest: string(),
    receipt: string(), outcome: string(), payload: string(), parents: string() })
    .index("by_field_seq", ["ownerId", "dashboardId", "questionId", "field", "seq"])
    .index("by_op", ["ownerId", "deviceId", "opId"]),
  quota: table({ key: string(), enrolledAccounts: number(), headsTotal: number(), eventsTotal: number() })
    .index("by_key", ["key"]),
};
