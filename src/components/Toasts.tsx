import { useToastStore, type ToastKind } from "../stores/toastStore";

const STYLES: Record<ToastKind, string> = {
  success: "bg-success-soft-alt text-success-strong",
  warning: "bg-warning-soft text-warning-strong",
  error: "bg-danger-soft text-danger-strong",
};

/** Toasts empilhados no canto inferior direito, acima da barra do player. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div
      aria-live="polite"
      // V15 — no centro, acima do player: no canto direito o aviso caía em
      // cima do "Salvar no arquivo" dos detalhes, e quem salvava duas músicas
      // seguidas não conseguia clicar na segunda (achado do E2E)
      className="pointer-events-none fixed bottom-28 left-1/2 z-50 flex w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2 baixa:bottom-24"
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
