import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./Icon";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  flush = false,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Content runs to the card's edges, for tables. */
  flush?: boolean;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p className="muted small">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={flush ? "card-flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "toggle-row disabled" : "toggle-row"}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description && <span className="muted small">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}

export function Alert({
  kind,
  children,
}: {
  kind: "error" | "warn" | "ok" | "info";
  children: ReactNode;
}) {
  const icon =
    kind === "ok"
      ? "check"
      : kind === "error"
        ? "error"
        : kind === "info"
          ? "shield"
          : "warn";
  return (
    <div className={`alert ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <Icon name={icon} size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Skeleton({ height = 16 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} />;
}

// ---------------------------------------------------------- toasts and dialogs

interface DialogRequest {
  title: string;
  message?: string;
  confirmLabel: string;
  danger: boolean;
  /** When set, the dialog asks for text. */
  input?: { label: string; value: string; maxLength?: number };
  resolve: (result: string | boolean | null) => void;
}

interface Feedback {
  toast: (message: string, kind?: "ok" | "error") => void;
  confirm: (options: {
    title: string;
    message?: string;
    confirmLabel?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  askText: (options: {
    title: string;
    label: string;
    value?: string;
    maxLength?: number;
    confirmLabel?: string;
  }) => Promise<string | null>;
}

const FeedbackContext = createContext<Feedback | null>(null);

export function useFeedback(): Feedback {
  return useContext(FeedbackContext)!;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<
    { id: number; message: string; kind: "ok" | "error" }[]
  >([]);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [text, setText] = useState("");
  const nextId = useRef(1);

  const toast = useCallback<Feedback["toast"]>((message, kind = "ok") => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, message, kind }]);
    setTimeout(
      () => setToasts((list) => list.filter((item) => item.id !== id)),
      kind === "error" ? 8000 : 4500,
    );
  }, []);

  const confirm = useCallback<Feedback["confirm"]>(
    (options) =>
      new Promise((resolve) => {
        setDialog({
          title: options.title,
          message: options.message,
          confirmLabel: options.confirmLabel ?? "Confirm",
          danger: options.danger ?? false,
          resolve: (result) => resolve(result === true),
        });
      }),
    [],
  );

  const askText = useCallback<Feedback["askText"]>(
    (options) =>
      new Promise((resolve) => {
        setText(options.value ?? "");
        setDialog({
          title: options.title,
          confirmLabel: options.confirmLabel ?? "Save",
          danger: false,
          input: {
            label: options.label,
            value: options.value ?? "",
            maxLength: options.maxLength,
          },
          resolve: (result) => resolve(typeof result === "string" ? result : null),
        });
      }),
    [],
  );

  const close = (result: string | boolean | null) => {
    dialog?.resolve(result);
    setDialog(null);
  };

  useEffect(() => {
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dialog.resolve(null);
        setDialog(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  return (
    <FeedbackContext.Provider value={{ toast, confirm, askText }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`} role="status">
            <Icon name={item.kind === "ok" ? "check" : "error"} size={16} />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
      {dialog && (
        <div className="overlay center">
          <form
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={dialog.title}
            onSubmit={(event) => {
              event.preventDefault();
              close(dialog.input ? text.trim() : true);
            }}
          >
            <h2>{dialog.title}</h2>
            {dialog.message && <p className="muted">{dialog.message}</p>}
            {dialog.input && (
              <label className="field">
                <span>{dialog.input.label}</span>
                <input
                  autoFocus
                  required
                  value={text}
                  maxLength={dialog.input.maxLength}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
            )}
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => close(null)}>
                Cancel
              </button>
              <button
                className={dialog.danger ? "button danger-solid" : "button primary"}
                autoFocus={!dialog.input}
              >
                {dialog.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      )}
    </FeedbackContext.Provider>
  );
}
