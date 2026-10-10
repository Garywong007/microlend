import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { friendlyError, shortHash, STATUS_HINT } from '../lib/format.js';

export function Card({ title, subtitle, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ status }) {
  return (
    <span className={`badge badge-${String(status).toLowerCase()}`} title={STATUS_HINT[status] || ''}>
      {status}
    </span>
  );
}

export function Btn({ children, variant = 'primary', busy, disabled, className = '', ...props }) {
  return (
    <button className={`btn btn-${variant} ${className}`.trim()} disabled={disabled || busy} {...props}>
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

export const Empty = ({ children }) => <p className="empty">{children}</p>;
export const Loading = () => <p className="muted">Loading…</p>;
export const ErrorNote = ({ error }) => (error ? <p className="error-note">{friendlyError(error)}</p> : null);

/** Loads data when the component mounts, when deps change and after every confirmed transaction. */
export function useAsync(fn, deps = []) {
  const { version } = useApp();
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // re-armed on every mount (React StrictMode mounts twice in dev)
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await fnRef.current();
      if (alive.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (alive.current) setState((s) => ({ data: s.data, loading: false, error }));
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, version, ...deps]);
  return { ...state, reload: load };
}

export function Toasts() {
  const { toasts, dismissToast, config } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <div>
            <div>{t.text}</div>
            {t.hash && (
              <div className="small muted mono">
                {config?.explorerUrl ? (
                  <a href={`${config.explorerUrl}/tx/${t.hash}`} target="_blank" rel="noreferrer">tx {shortHash(t.hash)}</a>
                ) : (
                  <>tx {shortHash(t.hash)}</>
                )}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
