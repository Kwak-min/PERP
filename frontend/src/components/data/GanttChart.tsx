export type GanttTask = Readonly<{
  label: string;
  owner: string;
  start: number;
  span: number;
  progress: number;
  milestone?: boolean;
  late?: boolean;
}>;

export function GanttChart({
  columns,
  tasks,
  todayIndex,
}: Readonly<{ columns: readonly string[]; tasks: readonly GanttTask[]; todayIndex?: number }>) {
  const total = Math.max(1, columns.length);
  return (
    <div className="gantt">
      <div className="gantt__head">
        <span className="gantt__label-col">업무</span>
        <div className="gantt__axis">
          {columns.map((column, index) => (
            <span key={column} className={index === todayIndex ? "gantt__tick gantt__tick--today" : "gantt__tick"}>
              {column}
            </span>
          ))}
        </div>
      </div>
      <div className="gantt__rows">
        {tasks.map((task) => {
          const barLeft = Math.max(0, Math.min((task.start / total) * 100, 99));
          const barWidth = Math.max(0, Math.min((task.span / total) * 100, 100 - barLeft));
          const milestoneLeft = Math.min(((task.start + task.span) / total) * 100, 97);
          return (
            <div className="gantt__row" key={task.label}>
              <div className="gantt__label-col">
                <b>{task.label}</b>
                <span>{task.owner}</span>
              </div>
              <div className="gantt__track">
                {columns.map((column, index) => (
                  <span key={column} className={index === todayIndex ? "gantt__cell gantt__cell--today" : "gantt__cell"} />
                ))}
                <div
                  className={task.late ? "gantt__bar gantt__bar--late" : "gantt__bar"}
                  style={{
                    left: `${barLeft}%`,
                    width: `${barWidth}%`,
                  }}
                >
                  <span className="gantt__fill" style={{ width: `${task.progress}%` }} />
                  <span className="gantt__bar-text">{task.progress}%</span>
                </div>
                {task.milestone && (
                  <span
                    className="gantt__milestone"
                    style={{ left: `${milestoneLeft}%` }}
                    aria-label="마일스톤"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
