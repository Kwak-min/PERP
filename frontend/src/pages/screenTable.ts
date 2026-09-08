import { z } from "zod";

import type { ScreenFilter } from "./screenFilters";

export type TableRow = Readonly<{
  id: string | null;
  cells: readonly string[];
  values: Readonly<Record<string, unknown>>;
}>;

export type TableData = Readonly<{
  columns: readonly string[];
  rows: readonly TableRow[];
}>;

const listSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())) });

export function liveTable(data: unknown): TableData | null {
  const parsed = listSchema.safeParse(data);
  if (!parsed.success || parsed.data.items.length === 0) return null;
  const records = parsed.data.items;
  const columns = Object.keys(records[0] ?? {}).filter((key) => key !== "__id").slice(0, 6);
  return {
    columns,
    rows: records.map((record) => ({
      id: record.__id != null ? String(record.__id) : record.id != null ? String(record.id) : null,
      values: record,
      cells: columns.map((column) => {
        const value = record[column];
        if (value === null || value === undefined) return "—";
        if (typeof value === "number") return value.toLocaleString("ko-KR");
        if (typeof value === "boolean") return value ? "예" : "아니요";
        if (Array.isArray(value)) return `${value.length}개`;
        if (typeof value === "object") return "상세";
        return String(value);
      }),
    })),
  };
}

export function filterTable(table: TableData, selection: Readonly<{ query: string; filter: ScreenFilter }>): TableData {
  const needle = selection.query.trim().toLowerCase();
  return {
    ...table,
    rows: table.rows.filter((row) => {
      if (needle && !row.cells.some((cell) => cell.toLowerCase().includes(needle))) return false;
      const filter = selection.filter;
      switch (filter.kind) {
        case "all": return true;
        case "status": return filter.values.some((value) => value === row.values.status);
      }
    }),
  };
}

const PAGE_SIZE = 10;

export function paginateTable(table: TableData, requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(table.rows.length / PAGE_SIZE));
  const currentPage = Math.max(1, Math.min(requestedPage, pageCount));
  const offset = (currentPage - 1) * PAGE_SIZE;
  return {
    currentPage,
    pageCount,
    start: table.rows.length === 0 ? 0 : offset + 1,
    end: Math.min(offset + PAGE_SIZE, table.rows.length),
    table: { ...table, rows: table.rows.slice(offset, offset + PAGE_SIZE) },
  };
}

export function toCsv(table: TableData): string {
  const escape = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell);
  return [table.columns.map(escape).join(","), ...table.rows.map((row) => row.cells.map(escape).join(","))].join("\n");
}
