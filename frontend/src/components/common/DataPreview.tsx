const KOREAN_LABELS: Readonly<Record<string, string>> = {
  members: "구성원",
  projects: "프로젝트",
  tasks: "업무",
  documents: "문서",
  ai_requests: "AI 요청",
  ai_cost_micro: "AI 비용",
};

export function displayLabel(key: string): string {
  return KOREAN_LABELS[key] ?? key.replaceAll("_", " ");
}

export function displayValue(value: unknown, key = ""): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "예" : "아니요";
  if (typeof value === "number") {
    if (key === "ai_cost_micro") {
      const dollars = value / 1_000_000;
      return `US$${dollars === 0 ? "0.00" : dollars.toFixed(4)}`;
    }
    return value.toLocaleString("ko-KR");
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `${value.length}개`;
  return "상세 보기";
}

function rowsOf(data: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    );
  }
  if (data && typeof data === "object" && "items" in data) {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) {
      return items.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      );
    }
  }
  return [];
}

export function DataPreview({ data }: Readonly<{ data: unknown }>) {
  const rows = rowsOf(data);
  if (rows.length > 0) {
    const columns = Object.keys(rows[0] ?? {}).slice(0, 5);
    return (
      <div
        className="table-wrap"
        role="region"
        aria-label="데이터 표, 가로로 스크롤할 수 있습니다"
        tabIndex={0}
      >
        <p className="table-scroll-hint">표를 좌우로 스크롤해 모든 열을 확인할 수 있습니다.</p>
        <table>
          <thead>
            <tr>{columns.map((column) => <th key={column}>{displayLabel(column)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row, index) => (
              <tr key={String(row.id ?? index)}>
                {columns.map((column) => <td key={column}>{displayValue(row[column], column)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (data && typeof data === "object") {
    return (
      <dl className="metric-grid">
        {Object.entries(data)
          .filter(([, value]) => typeof value !== "object" || value === null)
          .slice(0, 8)
          .map(([key, value]) => (
            <div className="metric" key={key}>
              <dt>{displayLabel(key)}</dt>
              <dd>{displayValue(value, key)}</dd>
            </div>
          ))}
      </dl>
    );
  }
  return null;
}
