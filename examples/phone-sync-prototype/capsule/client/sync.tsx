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
type Op = { protocolVersion: 2; contentRevision: string; dashboardId: string; questionId: string; field: string;
  deviceId: string; opId: string; kind: "save" | "clear" | "resolve"; baseRevision: number; payload: string; parents: string[] };
// op = the complete operation minted for this text; any retry replays it byte for byte under its opId.
// outbox: sending -> uncertain (no acknowledgement) -> absent (receipt null so far); landed = receipt revision
// the head must reach before the draft is dropped.
type Draft = { text: string; base: number; account?: string; op?: Op; outbox?: "sending" | "uncertain" | "absent";
  capacity?: true; landed?: number };
type State = "empty" | "draft" | "saving" | "saved" | "conflict" | "capacity" | "uncertain";

const serif = "[font-family:Charter,'Iowan_Old_Style','Palatino_Linotype',Georgia,serif]";
const QUESTIONS = [["q-orbit-r1", "Which moment would you replay first?"], ["q-tide-r1", "What should change before the next take?"]];
const STATES: Record<State, [label: string, glyph: string, tone: string, detail?: string]> = {
  empty: ["Not answered", "○", "#5B6670"],
  draft: ["Unsaved draft", "◐", "#9A5B0B", "Only on this phone until you save."],
  saving: ["Saving…", "◌", "#1D6B67"],
  saved: ["Saved", "●", "#1D6B67"],
  conflict: ["Conflict", "◆", "#A12C4C", "Another device saved a different version first. Keep one, or edit yours and save it."],
  capacity: ["Capacity reached", "▲", "#7A4A0E", "Test capacity is full. Your text stays on this phone, unsaved."],
  uncertain: ["Not confirmed", "?", "#4B47A0", "The save may have landed. Checking before anything is sent again."],
};

function deviceId() {
  const key = "nl-phone-sync:device";
  if (!localStorage.getItem(key)) localStorage.setItem(key, `device-${crypto.randomUUID()}`);
  return localStorage.getItem(key)!;
}
const ABSENT = "The server has no record of this save yet. Saving again sends the same edit, so it can't land twice.";
function load(key: string, account: string): Draft | null {
  const draft = JSON.parse(localStorage.getItem(key) ?? "null") as Draft | null;
  if (draft?.outbox && draft.account !== account) return null;
  // A send in flight at refresh or account switch is a lost acknowledgement until a receipt says otherwise.
  return draft?.outbox === "sending" ? { ...draft, outbox: "uncertain" } : draft;
}

function Reconcile({ port, op, settle }: { port: Port; op: Op; settle(r: Receipt | null): void }) {
  const receipt = port.useReceipt(op.deviceId, op.opId);
  useEffect(() => { if (receipt !== undefined) settle(receipt); }, [receipt]);
  return null;
}

function Field({ port, device, questionId, field }: { port: Port; device: string; questionId: string; field: "answer" | "note" }) {
  const key = `nl-phone-sync:${port.account}:${questionId}:${field}`, id = `${questionId}-${field}`;
  const [draft, setDraft] = useState(() => load(key, port.account));
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // After unmount (account switch) late results never write: the old account's outbox stays frozen.
  const write = (next: Draft | null) => {
    if (!alive.current) return;
    if (next) localStorage.setItem(key, JSON.stringify(next));
    else localStorage.removeItem(key);
    setDraft(next);
  };
  // Status labels fade in on a state change only, never on first load (heads arriving included).
  const settled = useRef(false);
  useEffect(() => { if (port.heads) settled.current = true; });
  const head = port.heads?.find(h => h.questionId === questionId && h.field === field), revision = head?.revision ?? 0;
  useEffect(() => { if (draft?.landed && revision >= draft.landed) write(null); }, [draft, revision]);
  const outbox = draft?.outbox;
  const state: State = outbox ? (outbox === "sending" ? "saving" : "uncertain") : draft?.landed ? "saving"
    : draft?.capacity ? "capacity" : head?.pending.length ? "conflict" : draft ? "draft" : head?.canonical ? "saved" : "empty";
  const values = head ? [...(head.canonical ? [head.canonical] : []), ...head.pending] : [];
  // In a conflict the editor keeps this phone's own edit (its latest pending value), never the canonical one.
  const mine = head?.pending.filter(v => v.deviceId === device).at(-1) ?? head?.pending.at(-1);
  const text = draft ? draft.text : state === "conflict" ? mine!.payload : head?.canonical?.payload ?? "";
  const frontier = values.map(v => v.id).sort();

  const fresh = (payload: string, parents?: string[]): Op => ({ protocolVersion: 2, contentRevision: FIXTURE.contentRevision,
    dashboardId: FIXTURE.dashboardId, questionId, field, deviceId: device, opId: `op-${crypto.randomUUID()}`,
    kind: parents ? "resolve" : payload ? "save" : "clear", baseRevision: parents ? revision : draft?.base ?? revision,
    payload, parents: parents ?? [] });
  // An uncertain or refused edit is retried with its stored operation; only new text mints a new opId.
  const retry = () => send(draft?.op && draft.op.payload === text ? draft.op : fresh(text));
  async function send(op: Op) {
    const keep = { text: op.payload, base: op.baseRevision, account: port.account, op };
    write({ ...keep, outbox: "sending" });
    try {
      write({ text: op.payload, base: op.baseRevision, landed: (await (op.kind === "resolve" ? port.resolve(op) : port.save(op))).revision });
    } catch (error) {
      write(String(error).includes("CAPACITY") ? { ...keep, capacity: true } : { ...keep, outbox: "uncertain" });
    }
  }

  const [label, glyph, tone, detail] = STATES[state];
  const action = `${press} mt-2 h-11 rounded-[10px] px-4 text-[15px] font-medium`;
  return (
    <div data-field={`${questionId}:${field}`} data-state={state} className="mt-4" style={{ "--tone": tone }}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[14px] font-medium">{field === "answer" ? "Answer" : "Note"}</label>
        <span key={state} role="status" className={"text-[13px] font-medium text-[var(--tone)] " + (settled.current
          ? "transition-[opacity,transform] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-y-0.5" : "")}>
          <span aria-hidden="true">{glyph}</span> {label}
        </span>
      </div>
      <textarea id={id} value={text} rows={field === "answer" ? 3 : 2} readOnly={state === "saving" || state === "uncertain"}
        onInput={e => write({ base: draft?.base ?? revision, ...(draft?.capacity ? { capacity: true } : {}),
          text: (e.currentTarget as HTMLTextAreaElement).value })}
        className="mt-1.5 block w-full resize-y rounded-[10px] border border-[#15212E]/15 border-l-4 border-l-[var(--tone)] bg-white/80 px-3 py-2.5 text-[16px] leading-relaxed transition-[border-color] duration-200 read-only:text-[#15212E]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D6B67]/40" />
      {detail && <p className="mt-1.5 text-[13px] text-[var(--tone)]">{outbox === "absent" ? ABSENT : detail}</p>}
      {(state === "draft" || state === "capacity" || outbox === "absent") && (
        <button type="button" onClick={retry} className={`${action} bg-[#15212E] text-white`}>{state === "capacity" ? "Try again" : "Save"}</button>
      )}
      {state === "conflict" && head && (
        <>
          <button type="button" disabled={values.some(v => v.payload === text)} onClick={() => send(fresh(text, frontier))}
            className={`${action} border border-[#A12C4C]/70 text-[#A12C4C] disabled:border-[#A12C4C]/30 disabled:text-[#A12C4C]/50`}>Save my edited version</button>
          <div className="mt-3 space-y-2">
            {values.map(v => (
              <div key={v.id} data-value={v.payload} className="flex items-center gap-3 rounded-[10px] bg-[#A12C4C]/[0.06] py-2 pl-3 pr-2">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-[15px]">{v.payload || "(cleared)"}</p>
                  <p className="text-[12px] text-[#5B6670]">{v === head.canonical
                    ? (v.deviceId === device ? "Saved from this phone" : "Saved from another device")
                    : (v.deviceId === device ? "Your edit, this phone" : "Edit from another device")}</p>
                </div>
                <button type="button" onClick={() => send(fresh(v.payload, frontier))} className={`${action} mt-0 shrink-0 bg-[#15212E] text-white`}>
                  {v.deviceId === device ? "Keep yours (this phone)" : "Keep the other device's"}</button>
              </div>
            ))}
          </div>
        </>
      )}
      {draft?.op && (outbox === "uncertain" || outbox === "absent") && <Reconcile port={port} op={draft.op}
        settle={r => write(r ? { text: draft.text, base: draft.base, landed: r.revision } : { ...draft, outbox: "absent" })} />}
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
