import { capsule, mutation, query } from "lakebed/server";
import { schema } from "./schema";
import * as store from "./store";
import * as reads from "./reads";

// Thin handlers: the owner is always the signed-in caller; guests and no-session calls are refused
// by both the app-wide policy and requireSignedIn(). No admin, grant or reset handler.
export default capsule({
  auth: { requireSignIn: true },
  schema,
  queries: {
    heads: query(async (ctx, dashboard: unknown) => {
      const { userId } = ctx.auth.requireSignedIn();
      return reads.heads(ctx.db, userId, dashboard);
    }),
    history: query(async (ctx, dashboard: unknown, question: unknown, field: unknown, page: unknown) => {
      const { userId } = ctx.auth.requireSignedIn();
      return reads.history(ctx.db, userId, dashboard, question, field, page);
    }),
    receipt: query(async (ctx, dashboard: unknown, device: unknown, op: unknown) => {
      const { userId } = ctx.auth.requireSignedIn();
      return reads.receipt(ctx.db, userId, dashboard, device, op);
    }),
  },
  mutations: {
    enroll: mutation(async (ctx) => {
      const { userId } = ctx.auth.requireSignedIn();
      return store.enroll(ctx.db, userId);
    }),
    save: mutation(async (ctx, op: unknown) => {
      const { userId } = ctx.auth.requireSignedIn();
      return store.save(ctx.db, userId, op);
    }),
    resolve: mutation(async (ctx, op: unknown) => {
      const { userId } = ctx.auth.requireSignedIn();
      return store.resolve(ctx.db, userId, op);
    }),
  },
});
