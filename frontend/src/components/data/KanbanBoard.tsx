export type KanbanCard = Readonly<{
  title: string;
  assignee: string;
  due?: string;
  priority?: "high" | "normal" | "low";
  tags?: readonly string[];
}>;

export type KanbanColumn = Readonly<{
  key: string;
  label: string;
  limit?: number;
  cards: readonly KanbanCard[];
}>;

export function KanbanBoard({ columns }: Readonly<{ columns: readonly KanbanColumn[] }>) {
  return (
    <div className="kanban">
      {columns.map((column) => {
        const over = column.limit !== undefined && column.cards.length > column.limit;
        return (
          <section className="kanban__col" key={column.key}>
            <header className="kanban__head">
              <span className="kanban__title">{column.label}</span>
              <span className={over ? "kanban__count kanban__count--over" : "kanban__count"}>
                {column.cards.length}
                {column.limit !== undefined && ` / ${column.limit}`}
              </span>
            </header>
            <div className="kanban__body">
              {column.cards.map((card) => (
                <article className="kanban__card" key={card.title}>
                  <p className="kanban__card-title">{card.title}</p>
                  <div className="kanban__card-meta">
                    <span className="kanban__avatar" aria-hidden="true">{card.assignee.slice(0, 1)}</span>
                    <span>{card.assignee}</span>
                    {card.due && <time className="kanban__due">{card.due}</time>}
                    {card.priority === "high" && <span className="kanban__flag">긴급</span>}
                  </div>
                  {card.tags && card.tags.length > 0 && (
                    <div className="kanban__tags">
                      {card.tags.map((tag) => (
                        <span className="kanban__tag" key={tag}>{tag}</span>
                      ))}
                    </div>
                  )}
                </article>
              ))}
              {column.cards.length === 0 && <p className="kanban__empty">항목 없음</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
