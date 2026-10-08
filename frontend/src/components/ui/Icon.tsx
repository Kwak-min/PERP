// 목업(index.html)의 ICONS 맵과 ic() 함수를 그대로 이식한 React 컴포넌트.
// 디자인은 목업을 절대 기준으로 유지한다 — 경로 데이터 변경 금지.

export const ICONS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  tasks: "M4 4h16v16H4z M8 12l3 3 5-6",
  check: "M5 12l4 4L19 6",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
  wallet: "M3 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7l12-3v3 M16 13.5h2",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6",
  pie: "M12 3v9h9 M20.2 15.5A9 9 0 1 1 8.5 3.7",
  users:
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M16 3.5a4 4 0 0 1 0 7.5 M18 14a6 6 0 0 1 4 7",
  box: "M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10",
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  door: "M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17 M3 21h18 M15 12h.01",
  umbrella: "M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9z M12 12v7a2 2 0 0 0 4 0",
  file: "M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z M14 3v5h5 M9 13h6 M9 17h6",
  message: "M4 5h16v11H8l-4 4z M8 9h8 M8 12h5",
  swap: "M4 8h14l-3-3 M20 16H6l3 3",
  inbox: "M4 13l2.5-8h11l2.5 8v6H4z M4 13h5l1 2h4l1-2h5",
  sparkles:
    "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  zap: "M13 2 4 14h7l-1 8 9-12h-7z",
  bell: "M6 16v-5a6 6 0 1 1 12 0v5l2 2H4z M10 21h4",
  chart: "M4 20V10 M10 20V4 M16 20v-7 M3 20h18",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  sliders: "M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M15 4v4 M9 10v4 M17 16v4",
  plug: "M9 3v5 M15 3v5 M7 8h10v3a5 5 0 0 1-10 0z M12 16v5",
  book: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z M5 17a3 3 0 0 1 3-3h11",
  graph:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.4 6.4l7.1 1.2M7 8.3l2.2 7.3M16.4 10l-4.8 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: "M12 5v14 M5 12h14",
  x: "M6 6l12 12 M18 6 6 18",
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  logout: "M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10",
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  alert: "M12 3l10 18H2z M12 10v5 M12 18h.01",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  upload: "M12 16V4 M7 9l5-5 5 5 M4 20h16",
  download: "M12 4v12 M7 11l5 5 5-5 M4 20h16",
  undo: "M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3",
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  flag: "M5 21V4 M5 4h12l-2 4 2 4H5",
  down: "M6 9l6 6 6-6",
  right: "M9 6l6 6-6 6",
  left: "M15 6l-6 6 6 6",
  building:
    "M4 21V5l8-2v18 M12 8h8v13 M8 8h.01 M8 12h.01 M8 16h.01 M16 12h.01 M16 16h.01 M2 21h20",
  send: "M4 12 20 4l-6 16-3-7z",
  bars: "M4 6h10 M4 12h16 M4 18h7",
  gantt: "M4 6h8 M8 12h10 M6 18h6",
  kanban:
    '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z M9 13l2 2 4-4"/>',
  coins:
    '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v4c0 1.7 2.7 3 6 3s6-1.3 6-3V7 M9 14v3c0 1.7 2.7 3 6 3s6-1.3 6-3v-4c0-1.4-1.9-2.6-4.5-2.9"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  play: "M7 4l13 8-13 8z",
  clip: "M20 12l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8",
  edit: "M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  up: "M6 15l6-6 6 6",
  admin:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  stamp: "M9 3h6v6l3 3v3H6v-3l3-3z M5 19h14 M5 21h14",
};

type IconProps = {
  name: keyof typeof ICONS | string;
  cls?: string;
};

export function Icon({ name, cls = "" }: IconProps) {
  const d = ICONS[name] ?? ICONS.file ?? "";
  const inner = d.startsWith("<") ? d : `<path d="${d}"/>`;
  return (
    <svg
      className={`ic ${cls}`.trim()}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
