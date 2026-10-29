/** @jsxImportSource preact */
import { canAccessApp, createClient, SignInWithGoogle, useAuth } from "lakebed/client";
import { useEffect, useState } from "preact/hooks";
import type app from "../server/index";
import { FIXTURE } from "../shared/protocol";
import { press } from "./player";
import { Answers, Shell, type FieldHead, type Port } from "./sync";

// Lakebed port for the shared answer UI. Data components mount only after sign-in and enroll().
const client = createClient<typeof app>();

export function App() {
  const auth = useAuth();
  return (
    <Shell>
      {canAccessApp() && auth.isSignedIn ? <Enrolled key={auth.userId} account={auth.userId} />
        : <SignInWithGoogle className={`${press} h-12 rounded-[10px] bg-[#15212E] px-5 text-white`} />}
    </Shell>
  );
}

function Enrolled({ account }: { account: string }) {
  const enroll = client.useMutation("enroll"), [status, setStatus] = useState("Joining the test dashboard…");
  useEffect(() => { enroll().then(() => setStatus(""), (e: Error) => setStatus(`Could not join: ${e.message}`)); }, []);
  return status ? <p className="text-[15px] text-[#5B6670]">{status}</p> : <Synced account={account} />;
}

function Synced({ account }: { account: string }) {
  const port: Port = { account, heads: client.useQuery("heads", FIXTURE.dashboardId) as FieldHead[] | undefined,
    save: client.useMutation("save") as Port["save"] };
  return <Answers port={port} />;
}
