import type { CSSProperties, ReactNode } from "react";

import { FileIcon } from "../icons";

// Grid-based table from research/helix-e2e-workbench-v1.html (upload file
// table). OWNER: step 0. Columns are data, so lanes never restyle the table.

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  cellClassName?: string;
};

export type DataTableProps<Row> = {
  label: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** CSS grid-template-columns; defaults to the reference file table. */
  template?: string;
  "data-testid"?: string;
};

export function DataTable<Row>({ label, columns, rows, rowKey, template, ...rest }: DataTableProps<Row>) {
  const style = template ? ({ "--hx-cols": template } as CSSProperties) : undefined;
  return (
    <div className="hx-table" role="table" aria-label={label} style={style} data-testid={rest["data-testid"]}>
      <div className="hx-trow head" role="row">
        {columns.map((column) => (
          <span role="columnheader" key={column.key}>
            {column.header}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div className="hx-trow" role="row" key={rowKey(row)}>
          {columns.map((column) => (
            <span role="cell" key={column.key} className={column.cellClassName}>
              {column.cell(row)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** File name cell: icon plus an ellipsized name. */
export function FileCell({ name }: { name: string }) {
  return (
    <span className="hx-cell-file">
      <FileIcon />
      <span className="hx-ellipsis">{name}</span>
    </span>
  );
}
