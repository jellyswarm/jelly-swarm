import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const ToastContext = createContext(() => ({ update() {}, dismiss() {} }));

/**
 * Bottom-right toasts. `toast(message, tone)` returns a handle, so a progress toast can turn into
 * its result in place. Identical non-progress messages refresh instead of stacking.
 */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());
  const seq = useRef(0);
  const itemsRef = useRef([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 240);
  }, []);

  const schedule = useCallback(
    (id, tone) => {
      clearTimeout(timers.current.get(id));
      if (tone !== "progress") timers.current.set(id, setTimeout(() => dismiss(id), tone === "error" ? 9000 : 5000));
    },
    [dismiss],
  );

  const toast = useCallback(
    (message, tone = "info") => {
      const same = tone !== "progress" && itemsRef.current.find((t) => !t.leaving && t.tone === tone && t.message === message);
      const id = same ? same.id : ++seq.current;
      if (!same) {
        const item = { id, message, tone };
        itemsRef.current = [...itemsRef.current, item];
        setItems((list) => [...list, item]);
      }
      schedule(id, tone);
      const handle = {
        update(msg, next = tone) {
          setItems((list) => list.map((t) => (t.id === id ? { ...t, message: msg, tone: next } : t)));
          schedule(id, next);
          return handle;
        },
        dismiss: () => dismiss(id),
      };
      return handle;
    },
    [dismiss, schedule],
  );

  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.leaving ? " leaving" : ""}`} data-tone={t.tone}>
            <span className="toast-dot" />
            <p>{t.message}</p>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
