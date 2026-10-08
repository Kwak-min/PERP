import { createRoot } from "react-dom/client";
import { AgentPanel } from "../src/components/layout/AgentPanel";
import { AppProvider, useAppContext } from "../src/context/AppContext";
import { sessionStore } from "../src/store/session";
import "../src/styles.css";

function Fixture() {
  const { setAgentOpen } = useAppContext();
  return <><button onClick={() => setAgentOpen(true)}>AI Agent</button>
    <button onClick={() => sessionStore.patch({ orgId: "pg:second" })}>회사 전환</button>
    <button onClick={() => sessionStore.patch({ token: "second-account" })}>계정 전환</button>
    <AgentPanel /></>;
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<AppProvider><Fixture /></AppProvider>);
