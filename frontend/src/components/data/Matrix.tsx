export type HeatRow = Readonly<{ name: string; role: string; cells: readonly number[]; capacity: number }>;

export function WorkloadHeatmap({
  columns,
  rows,
}: Readonly<{ columns: readonly string[]; rows: readonly HeatRow[] }>) {
  return (
    <div className="heatmap">
      <div className="heatmap__head">
        <span className="heatmap__name-col">구성원</span>
        {columns.map((column) => <span key={column} className="heatmap__tick">{column}</span>)}
        <span className="heatmap__tick">합계</span>
      </div>
      {rows.map((row) => {
        const total = row.cells.reduce((sum, cell) => sum + cell, 0);
        const over = total > row.capacity;
        return (
          <div className="heatmap__row" key={row.name}>
            <span className="heatmap__name-col">
              <b>{row.name}</b>
              <span>{row.role}</span>
            </span>
            {row.cells.map((cell, index) => {
              const level = cell === 0 ? 0 : cell <= 2 ? 1 : cell <= 4 ? 2 : cell <= 6 ? 3 : 4;
              return (
                <span
                  key={index}
                  className={`heatmap__cell heatmap__cell--${level}`}
                  title={`${columns[index] ?? ""} ${cell}시간`}
                >
                  {cell || ""}
                </span>
              );
            })}
            <span className={over ? "heatmap__total heatmap__total--over" : "heatmap__total"}>
              {total}/{row.capacity}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export type PermissionRow = Readonly<{ resource: string; allow: readonly boolean[] }>;

export function PermissionMatrix({
  roles,
  rows,
}: Readonly<{ roles: readonly string[]; rows: readonly PermissionRow[] }>) {
  return (
    <div className="table-wrap" role="region" aria-label="권한 매트릭스" tabIndex={0}>
      <table className="matrix">
        <thead>
          <tr>
            <th>리소스</th>
            {roles.map((role) => <th key={role} className="num">{role}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.resource}>
              <td>{row.resource}</td>
              {row.allow.map((ok, index) => (
                <td key={index} className="num">
                  <span className={ok ? "matrix__yes" : "matrix__no"} aria-label={ok ? "허용" : "차단"}>
                    {ok ? "허용" : "차단"}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
