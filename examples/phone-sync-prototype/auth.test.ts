import { expect, test } from "bun:test";

// Isolate the SDK mock from the real Lakebed database and component suites.
test("auth loading renders nothing; signed-out and guest sessions never mount data components", () => {
  const result = Bun.spawnSync([process.execPath, "-e", `
    const { mock } = await import("bun:test");
    const sdk = await import("lakebed/client");
    let auth = { isLoading: true, isSignedIn: false, userId: null };
    mock.module("lakebed/client", () => ({ ...sdk, useAuth: () => auth, canAccessApp: () => false }));
    const { App } = await import("./examples/phone-sync-prototype/capsule/client/index.tsx");
    if (App() !== null) throw new Error("Loading must render nothing");
    for (const isGuest of [false, true]) {
      auth = { isLoading: false, isSignedIn: false, isGuest, userId: isGuest ? "guest-test" : null };
      const view = App();
      if (view.props.children.type !== sdk.SignInWithGoogle) throw new Error("Expected sign-in gate, never Enrolled");
    }
  `], { cwd: new URL("../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
