import { capsule, mutation } from "lakebed/server";
import { schema } from "./schema";
import * as store from "./store";

// Thin handlers: the owner is always the signed-in caller; guests and no-session calls are refused
// by both the app-wide policy and requireSignedIn(). No query, admin, grant or reset handler (P1c adds reads).
export default capsule({
  auth: { requireSignIn: true },
  schema,
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
