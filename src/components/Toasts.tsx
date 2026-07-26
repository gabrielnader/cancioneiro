import { useToastStore, type ToastKind } from "../stores/toastStore";

const STYLES: Record<ToastKind, string> = {
  success: "bg-[#D1FAE5] text-[#065F46]",
  warning: "bg-[#FEF3C7] text-[#92400E]",
  error: "bg-[#FEE2E2] text-[#991B1B]",
};

/** Toasts empilhados no canto inferior direito, acima da barra do player. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-20 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded-md px-4 py-3 text-left text-[14px] shadow-md ${STYLES[t.kind]}`}
          role="status"
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
