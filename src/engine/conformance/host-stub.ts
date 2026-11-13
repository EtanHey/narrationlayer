// Scripted sender only, NOT yet a reading of VoiceLayer. S6h, S5h, S4h and S7h
// supply the host cases and broken stubs: capture/History/Ask/park/identity rules.
// Loans are stage B; the shared admission_epoch counter is a stub choice, not VoiceLayer's rule.
import type { Clock, HostStub, Json } from "./binding.js";

export class ScriptedHost implements HostStub {
  private issued: Json[] = [];
  private epoch = 0;
  private sequence = 0;
  constructor(private clock: Clock, private send: (message: Json) => void = () => {}) {}
  get records(): readonly Json[] { return structuredClone(this.issued); }
  script(steps: readonly { delay_ms: number; message: Json }[]): void {
    for (const step of steps) {
      const message = structuredClone(step.message);
      this.clock.schedule(step.delay_ms, () => this.issue(message));
    }
  }
  private issue(message: Json): void {
    this.issued.push({ message: structuredClone(message), t_mono_ms: this.clock.monotonic() });
    this.send(structuredClone(message));
  }
  capture(state: "requested" | "active" | "idle"): void { this.issue({ protocol: "nl.engine/1", type: "capture_state", admission_epoch: ++this.epoch, capture: state }); }
  permit(session: string): void { this.issue({ protocol: "nl.engine/1", type: "speaker_grant", admission_epoch: ++this.epoch, permit_id: `permit-${++this.sequence}`, session_id: session, scope: "session" }); }
  revoke(session: string, loan_id?: string): void { this.issue({ protocol: "nl.engine/1", type: "speaker_revoke", admission_epoch: ++this.epoch, reason: "capture", ...(loan_id === undefined ? {} : { loan_id }) }); }
  loan(from: string, to: string): void { this.issue({ protocol: "nl.engine/1", type: "loan_restore", loan_id: from, session_id: to }); }
}
