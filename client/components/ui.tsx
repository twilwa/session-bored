// ABOUTME: Provides Greenroom's shared buttons, controls, tables, modal, toast, and state views.
// ABOUTME: Gives independent feature lanes one accessible visual language and interaction contract.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  tone = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "quiet" | "signal" }) {
  return <button className={`button button--${tone} ${className}`.trim()} {...props} />;
}

export function TextField({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = props.id ?? props.name;
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <input className="field__control" id={id} {...props} />
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function SelectField({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = props.id ?? props.name;
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <select className="field__control" id={id} {...props}>
        {children}
      </select>
    </label>
  );
}

export interface TableColumn<Row> {
  key: string;
  label: string;
  render: (row: Row) => ReactNode;
}

export function DataTable<Row extends { id: string }>({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: Array<TableColumn<Row>>;
  rows: Row[];
}) {
  if (rows.length === 0) {
    return <EmptyState title={`No ${caption.toLowerCase()} yet`} description="Saved items will appear here." />;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption>{caption}</caption>
        <thead>
          <tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>{columns.map((column) => <td key={column.key}>{column.render(row)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  if (!open) {
    return null;
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="modal-title"
        aria-modal="true"
        className="modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h2 id="modal-title">{title}</h2>
          <Button aria-label="Close dialog" onClick={onClose} tone="quiet">×</Button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div aria-live="polite" className={message === null ? "toast" : "toast toast--visible"} role="status">
      {message}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <section className="state-card state-card--empty">
      <span aria-hidden="true" className="state-card__mark">○</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </section>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div aria-label={label} className="loading-state" role="status">
      <span className="loading-state__bar" />
      <span className="loading-state__bar" />
      <span className="loading-state__bar" />
    </div>
  );
}

export function StatusChip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "signal" }) {
  return <span className={`status-chip status-chip--${tone}`}>{children}</span>;
}
