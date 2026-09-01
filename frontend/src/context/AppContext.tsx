import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type AppContextValue = Readonly<{
  agentOpen: boolean;
  sidebarOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleAgent: () => void;
  toggleSidebar: () => void;
}>;

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toggleAgent = useCallback(() => setAgentOpen((value) => !value), []);
  const toggleSidebar = useCallback(
    () => setSidebarOpen((value) => !value),
    [],
  );
  const value = useMemo(
    () => ({
      agentOpen,
      sidebarOpen,
      setAgentOpen,
      setSidebarOpen,
      toggleAgent,
      toggleSidebar,
    }),
    [agentOpen, sidebarOpen, toggleAgent, toggleSidebar],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useAppContext must be used inside AppProvider");
  return value;
}
