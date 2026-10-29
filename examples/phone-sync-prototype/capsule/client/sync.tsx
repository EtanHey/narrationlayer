/** @jsxImportSource preact */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { FIXTURE } from "../shared/protocol";
import { Player, press } from "./player";

// P2a answer sync. Data comes through a Port: index.tsx wires Lakebed; harness/backend.ts wires a
// labelled in-memory adapter. Drafts persist per account+field and never yield to a server value (C2).
export type Value = { id: string; payload: string; deviceId: string };
export type FieldHead = { questionId: string; field: string; revision: number; canonical: Value | null; pending: Value[] };
export type Receipt = { outcome: "accepted" | "conflict"; eventId: string; revision: number; canonicalEventId: string | null };
export type Port = { account: string; heads: FieldHead[] | undefined; save(op: object): Promise<Receipt>;
  resolve(op: object): Promise<Receipt>; useReceipt(deviceId: string, opId: string): Receipt | null | undefined };
// sent = outbox entry; landed = receipt revision the head must reach before the draft is dropped.
type Draft = { text: string; base: number; capacity?: true; sent?: { opId: string; uncertain?: true }; landed?: number };
type State = "empty" | "draft" | "saving" | "saved" | "conflict" | "capacity" | "uncertain";

const serif = "[font-family:Charter,'Iowan_Old_Style','Palatino_Linotype',Georgia,serif]";
const QUESTIONS = [["q-orbit-r1", "Which moment would you replay first?"], ["q-tide-r1", "What should change before the next take?"]];
const STATES: Record<State, [label: string, glyph: string, tone: string, detail?: string]> = {
  empty: ["Not answered", "○", "#8A949C"],
  draft: ["Unsaved draft", "◐", "#9A5B0B", "Only on this phone until you save."],
  saving: ["Saving…", "◌", "#1D6B67"],
  saved: ["Saved", "●", "#1D6B67"],
  conflict: ["Conflict", "◆", "#A12C4C", "Another version was saved first. Keep one, or edit the text and use that."],
  capacity: ["Capacity reached", "▲", "#7A4A0E", "Test capacity is full. Your text stays on this phone, unsaved."],
  uncertain: ["Not confirmed", "?", "#4B47A0", "The save may have landed. Checking before anything is sent again."],
};

function deviceId() {
  const key = "nl-phone-sync:device";
  if (!localStorage.getItem(key)) localStorage.setItem(key, `device-${crypto.randomUUID()}`);
  return localStorage.getItem(key)!;
}
function load(key: string): Draft | null {
  const draft = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null;
  // A send in flight at refresh or account switch is a lost acknowledgement until a receipt says otherwise.
  return draft?.sent ? { ...draft, sent: { opId: draft.sent.opId, uncertain: true } } : draft;
}

function Reconcile({ port, device, opId, settle }: { port: Port; device: string; opId: string; settle(r: Receipt | null): void }) {
  const receipt = port.useReceipt(device, opId);
  useEffect(() => { if (receipt !== undefined) settle(receipt); }, [receipt]);
  return null;
}

function Field({ port, device, questionId, field }: { port: Port; device: string; questionId: string; field: "answer" | "note" }) {
  const key = `nl-phone-sync:${port.account}:${questionId}:${field}`, id = `${questionId}-${field}`;
  const [draft, setDraft] = useState(() => load(key));
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // After unmount (account switch) late results never write: the old account's outbox stays frozen.
  const write = (next: Draft | null) => {
    if (!alive.current) return;
    if (next) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
    setDraft(next);
  };
  const head = port.heads?.find(h => h.questionId === questionId && h.field === field), revision = head?.revision ?? 0;
  useEffect(() => { if (draft?.landed && revision >= draft.landed) write(null); }, [draft, revision]);
  const state: State = draft?.sent ? (draft.sent.uncertain ? "uncertain" : "saving") : draft?.landed ? "saving"
    : draft?.capacity ? "capacity" : head?.pending.length ? "conflict" : draft ? "draft" : head?.canonical ? "saved" : "empty";
  const text = draft ? draft.text : head?.canonical?.payload ?? "";
  const values = head ? [...(head.canonical ? [head.canonical] : []), ...head.pending] : [];
  const frontier = values.map(v => v.id).sort();

  async function send(payload: string, parents?: string[]) {
    const opId = `op-${crypto.randomUUID()}`, base = parents ? revision : draft?.base ?? revision;
    write({ text: payload, base, sent: { opId } });
    const op = { protocolVersion: 2, contentRevision: FIXTURE.contentRevision, dashboardId: FIXTURE.dashboardId,
      questionId, field, deviceId: device, opId, kind: parents ? "resolve" : payload ? "save" : "clear",
      baseRevision: base, payload, parents: parents ?? [] };
    try {
      write({ text: payload, base, landed: (await (parents ? port.resolve(op) : port.save(op))).revision });
    } catch (error) {
      write(String(error).includes("CAPACITY") ? { text: payload, base, capacity: true } : { text: payload, base, sent: { opId, uncertain: true } });
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
      <textarea id={id} value={text} rows={field === "answer" ? 3 : 2} readOnly={state === "saving" || state === "uncertain"}
        onInput={e => write({ ...(draft ?? { base: revision }), text: (e.currentTarget as HTMLTextAreaElement).value })}
        className="mt-1.5 block w-full resize-y rounded-[10px] border border-[#15212E]/15 border-l-4 border-l-[var(--tone)] bg-white/80 px-3 py-2.5 text-[16px] leading-relaxed transition-[border-color] duration-200 read-only:text-[#15212E]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D6B67]/40" />
      {detail && <p className="mt-1.5 text-[13px] text-[var(--tone)]">{detail}</p>}
      {(state === "draft" || state === "capacity") && (
        <button type="button" onClick={() => send(text)} className={`${action} bg-[#15212E] text-white`}>{state === "capacity" ? "Try again" : "Save"}</button>
      )}
      {state === "conflict" && head && (
        <div className="mt-3 space-y-2">
          {values.map(v => (
            <div key={v.id} data-value={v.payload} className="flex items-center gap-3 rounded-[10px] bg-[#A12C4C]/[0.06] py-2 pl-3 pr-2">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-[15px]">{v.payload || "(cleared)"}</p>
                <p className="text-[12px] text-[#5B6670]">{v === head.canonical ? "Saved version" : "Competing edit"}, {v.deviceId === device ? "this phone" : "another device"}</p>
              </div>
              <button type="button" onClick={() => send(v.payload, frontier)} className={`${action} mt-0 shrink-0 border border-[#A12C4C]/40 text-[#A12C4C]`}>Keep this</button>
            </div>
          ))}
          <button type="button" onClick={() => send(text, frontier)} className={`${action} bg-[#A12C4C] text-white`}>Use the text above</button>
        </div>
      )}
      {draft?.sent?.uncertain && <Reconcile port={port} device={device} opId={draft.sent.opId}
        settle={r => write(r ? { text: draft.text, base: draft.base, landed: r.revision } : { text: draft.text, base: draft.base })} />}
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
