import { create } from 'zustand';

export interface Toast {
  id: string;
  type: 'success' | 'attention' | 'error' | 'info';
  message: string;
  detail?: string;
  createdAt: number;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id' | 'createdAt'>) => void;
  removeToast: (id: string) => void;
  clearAll: () => void;
}

const MAX_TOASTS = 2;
const AUTO_DISMISS_MS = 5000;

/**
 * Global toast store.
 * - Max 2 toasts visible at once (newest at bottom)
 * - Auto-dismiss after 5 seconds
 * - Click to dismiss
 */
export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newToast: Toast = { ...toast, id, createdAt: Date.now() };

    set((state) => {
      const updated = [...state.toasts, newToast].slice(-MAX_TOASTS);
      return { toasts: updated };
    });

    // Auto-dismiss
    setTimeout(() => {
      get().removeToast(id);
    }, AUTO_DISMISS_MS);
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearAll: () => set({ toasts: [] }),
}));

const DOT_COLORS: Record<Toast['type'], string> = {
  success: 'bg-moss',
  attention: 'bg-clay',
  error: 'bg-crimson',
  info: 'bg-sky',
};

/**
 * Toast container — renders at the bottom of the side panel.
 * PPHunt style: surface-card, colored dot, serif text, 1px hairline border.
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          onClick={() => removeToast(toast.id)}
          className="pointer-events-auto cursor-pointer bg-surface-card border border-hairline rounded-md p-3 flex items-start gap-2.5 transition-opacity duration-300"
          role="alert"
          aria-live="polite"
        >
          <span
            className={`w-2.5 h-2.5 rounded-full ${DOT_COLORS[toast.type]} shrink-0 mt-1`}
          />
          <div className="min-w-0 flex-1">
            <p className="font-serif text-sm font-medium text-ink">{toast.message}</p>
            {toast.detail && (
              <p className="font-serif text-xs text-ink-muted mt-0.5 leading-relaxed">
                {toast.detail}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Helper to add a toast from anywhere in the app.
 */
export function showToast(
  type: Toast['type'],
  message: string,
  detail?: string
) {
  useToastStore.getState().addToast({ type, message, detail });
}
