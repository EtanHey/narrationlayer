/** @jsxImportSource preact */
import { render } from "preact";
import { useState } from "preact/hooks";
import { press } from "../capsule/client/player";
import { Answers, Shell } from "../capsule/client/sync";
import { createHarness, useHarnessPort } from "./backend";

// LOCAL HARNESS page: the capsule's own components over the labelled in-memory adapter.
const h = createHarness();
function View({ account }: { account: string }) { return <Answers port={useHarnessPort(h, account)} />; }

function HarnessPage() {
  const [account, setAccount] = useState("alice"), [, redraw] = useState(0);
  const toggle = (apply: () => void) => () => { apply(); redraw(n => n + 1); };
  const control = (on = false) => `${press} h-11 rounded-[10px] px-3 text-[13px] ${on ? "bg-white text-[#15212E]" : "border border-white/35"}`;
  const banner = (
    <div className="bg-[repeating-linear-gradient(135deg,#2B2F6B_0_14px,#33387A_14px_28px)] px-4 py-3 text-white md:px-8">
      <p className="text-[15px] font-semibold">LOCAL HARNESS: not signed-in Lakebed</p>
      <p className="mt-0.5 max-w-[70ch] text-[13px] text-white/80">In-memory adapter with injected test accounts. These controls stand in for other accounts and a slow network.</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {["alice", "bob"].map(a => <button type="button" key={a} aria-pressed={a === account} onClick={() => setAccount(a)} className={control(a === account)}>Test account {a}</button>)}
        <button type="button" aria-pressed={h.latency > 0} onClick={toggle(() => (h.latency = h.latency ? 0 : 1500))} className={control(h.latency > 0)}>Slow network</button>
      </div>
    </div>
  );
  return <Shell banner={banner}><View key={account} account={account} /></Shell>;
}

render(<HarnessPage />, document.getElementById("app")!);
