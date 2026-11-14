import { expect, test } from "bun:test";
import type { Binding } from "../../src/engine/conformance/binding";
import engine from "../../src/engine/conformance/engine-binding";
import { privacyCases, privacyText } from "../../src/engine/conformance/privacy-cases";
import { runCase } from "../../src/engine/conformance/runner";
for (const wrong of ["lifecycle", "extra", "details", "console", "stdout", "stderr", "key", "history", "second-error"]) test(`privacy: own wrong engine ${wrong} is caught`, async () => {
  const binding: Binding = { name: wrong, create(host) {
    const c = engine.create(host); let reads = 0;
    return { ...c, send(message) { if (message && typeof message === "object" && !Array.isArray(message) && message.type === "narrate") reads++; c.send(message); },
      events: (async function* () { for await (const e of c.events) {
        if (wrong === "console" && e.type === "error" && e.code === "SYNTH_FAILED") console.error(privacyText);
        if ((wrong === "stdout" || wrong === "stderr") && e.type === "error" && e.code === "SYNTH_FAILED") process[wrong].write(privacyText);
        yield wrong === "lifecycle" && e.type === "lifecycle" ? { ...e, kind: privacyText.slice(0, 16) }
          : wrong === "extra" && e.type === "accepted" ? { ...e, extra: privacyText }
          : wrong === "details" && e.type === "error" && e.code === "INPUT_TOO_LONG" ? { ...e, details: { text: privacyText } }
          : wrong === "key" && e.type === "accepted" ? { ...e, [privacyText.slice(20, 28)]: true }
          : wrong === "history" && e.type === "outcome" ? { ...e, history: { ...e.history, reason: privacyText } }
          : wrong === "second-error" && reads === 2 && e.type === "error" && e.code === "SYNTH_FAILED" ? { ...e, message: privacyText } : e;
      } })() };
  } };
  expect((await runCase("PRIV-01e", binding, privacyCases["PRIV-01e"])).result).toBe("fail");
});
