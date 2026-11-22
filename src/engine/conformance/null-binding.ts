import type { Binding } from "./binding.js";
export default {
  name: "null",
  create: () => ({ send() {}, events: (async function* () {})(), async shutdown() {} }),
} satisfies Binding;
