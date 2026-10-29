/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { FIXTURE } from "../shared/protocol";
import { Player, press } from "./player";

// P2a answer sync. Data comes through a Port: index.tsx wires Lakebed; harness/backend.ts wires a
// labelled in-memory adapter. Drafts persist per account+field and never yield to a server value (C2).
export type Value = { id: string; payload: string; deviceId: string };
export type FieldHead = { questionId: string; field: string; revision: number; canonical: Value | null; pending: Value[] };
export type Receipt = { outcome: "accepted" | "conflict"; eventId: string; revision: number; canonicalEventId: string | null };
export type Port = { account: string; heads: FieldHead[] | undefined; save(op: object): Promise<Receipt> };
// sent = outbox entry; landed = receipt revision the head must reach before the draft is dropped.
type Draft = { text: string; base: number; sent?: { opId: string }; landed?: number };
type State = "empty" | "draft" | "saving" | "saved";

const serif = "[font-family:Charter,'Iowan_Old_Style','Palatino_Linotype',Georgia,serif]";
const QUESTIONS = [["q-orbit-r1", "Which moment would you replay first?"], ["q-tide-r1", "What should change before the next take?"]];
const STATES: Record<State, [label: string, glyph: string, tone: string, detail?: string]> = {
  empty: ["Not answered", "○", "#8A949C"],
  draft: ["Unsaved draft", "◐", "#9A5B0B", "Only on this phone until you save."],
  saving: ["Saving…", "◌", "#1D6B67"],
  saved: ["Saved", "●", "#1D6B67"],
};

function deviceId() {
  const key = "nl-phone-sync:device";
  if (!localStorage.getItem(key)) localStorage.setItem(key, `device-${crypto.randomUUID()}`);
  return localStorage.getItem(key)!;
}
// P2a-states adds conflict, capacity and lost-acknowledgement (receipt) handling on top of this.
function load(key: string): Draft | null {
  const draft = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null;
  return draft?.sent ? { text: draft.text, base: draft.base } : draft;
}

function Field({ port, device, questionId, field }: { port: Port; device: string; questionId: string; field: "answer" | "note" }) {
  const key = `nl-phone-sync:${port.account}:${questionId}:${field}`, id = `${questionId}-${field}`;
  const [draft, setDraft] = useState(() => load(key));
  const write = (next: Draft | null) => {
    if (next) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
    setDraft(next);
  };
  const head = port.heads?.find(h => h.questionId === questionId && h.field === field), revision = head?.revision ?? 0;
  useEffect(() => { if (draft?.landed && revision >= draft.landed) write(null); }, [draft, revision]);
  const state: State = draft?.sent || draft?.landed ? "saving" : draft ? "draft" : head?.canonical ? "saved" : "empty";
  const text = draft ? draft.text : head?.canonical?.payload ?? "";

  async function send(payload: string) {
    const opId = `op-${crypto.randomUUID()}`, base = draft?.base ?? revision;
    write({ text: payload, base, sent: { opId } });
    const op = { protocolVersion: 2, contentRevision: FIXTURE.contentRevision, dashboardId: FIXTURE.dashboardId,
      questionId, field, deviceId: device, opId, kind: payload ? "save" : "clear", baseRevision: base, payload, parents: [] };
    try {
      write({ text: payload, base, landed: (await port.save(op)).revision });
    } catch {
      write({ text: payload, base });
    }
  }

  const [label, glyph, tone, detail] = STATES[state];
  const action = `${press} mt-2 h-11 rounded-[10px] px-4 text-[15px] font-medium`;
  return (
    <div data-field={`${questionId}:${field}`} data-state={state} className="mt-4" style={{ "--tone": tone }}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[14px] font-medium">{field === "answer" ? "Answer" : "Note"}</label>
        <span key={state} role="status" className="text-[13px] font-medium text-[var(--tone)] transition-[opacity,transform] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-y-0.5">
          <span aria-hidden="true">{glyph}</span> {label}
        </span>
      </div>
      <textarea id={id} value={text} rows={field === "answer" ? 3 : 2} readOnly={state === "saving"}
        onInput={e => write({ ...(draft ?? { base: revision }), text: (e.currentTarget as HTMLTextAreaElement).value })}
        className="mt-1.5 block w-full resize-y rounded-[10px] border border-[#15212E]/15 border-l-4 border-l-[var(--tone)] bg-white/80 px-3 py-2.5 text-[16px] leading-relaxed transition-[border-color] duration-200 read-only:text-[#15212E]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D6B67]/40" />
      {detail && <p className="mt-1.5 text-[13px] text-[var(--tone)]">{detail}</p>}
      {state === "draft" && <button type="button" onClick={() => send(text)} className={`${action} bg-[#15212E] text-white`}>Save</button>}
    </div>
  );
}

export function Answers({ port }: { port: Port }) {
  const [device] = useState(deviceId);
  return (
    <div className="divide-y divide-[#15212E]/10">
      {QUESTIONS.map(([questionId, prompt]) => (
        <section key={questionId} className="py-7 first:pt-0">
          <h2 className={`${serif} text-[1.3rem] leading-snug`}>{prompt}</h2>
          {(["answer", "note"] as const).map(f => <Field key={port.account + f} port={port} device={device} questionId={questionId!} field={f} />)}
        </section>
      ))}
    </div>
  );
}

export function Shell({ banner, children }: { banner?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div className="min-h-screen bg-[#E6ECEA] text-[#15212E] antialiased [font-family:ui-sans-serif,system-ui,sans-serif]">
      {banner}
      <main className="mx-auto grid max-w-5xl gap-8 px-4 py-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-14 md:px-8 md:py-12">
        <header className="md:sticky md:top-12 md:self-start">
          <h1 className={`${serif} text-[1.75rem] leading-tight`}>Listen, then answer</h1>
          <p className="mt-2 max-w-[38ch] text-[15px] text-[#5B6670]">Synthetic test data. Answers sync between your own signed-in devices.</p>
          <Player />
        </header>
        <div>{children}</div>
      </main>
    </div>
  );
}
