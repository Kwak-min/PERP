import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { VaultGraphScreen } from "../src/screens/VaultGraphScreen";
import { VaultScreen } from "../src/screens/VaultScreen";
import { KnowledgeGraphScreen } from "../src/screens/KnowledgeGraphScreen";
import { screens } from "../src/routes/catalog";
import "../src/styles.css";

// 실제 화면 컴포넌트 전용 QA 진입점. 앱 셸은 최종 SPA QA에서 별도로 검증한다.
const root = document.getElementById("root");
const company = location.pathname === "/documents/graph";
const list = location.pathname === "/vault";
const screen = screens.find(item => item.id === (company ? "DOC-004" : list ? "VLT-001" : "VLT-002"));
if (!root || !screen) throw new Error("Graph QA entry missing root or catalog route");
createRoot(root).render(<BrowserRouter>{company ? <KnowledgeGraphScreen screen={screen} /> : list ? <VaultScreen screen={screen} /> : <VaultGraphScreen screen={screen} />}</BrowserRouter>);
