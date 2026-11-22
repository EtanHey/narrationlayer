import type { Binding } from "./binding.js";
let instance = 0;
export default {
  name: "nondeterministic",
  create() {
    const nonce = ++instance;
    return { send() {}, events: (async function* () { yield { nonce }; })(), async shutdown() {} };
  },
} satisfies Binding;
