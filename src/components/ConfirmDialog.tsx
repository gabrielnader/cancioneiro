interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Diálogo de confirmação de ação destrutiva (F1/F5). */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-lg bg-surface p-5 shadow-xl">
        <p className="text-[15px] text-ink">{title}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-4 py-2 text-[15px] font-medium text-ink-secondary hover:bg-surface-hover"
            onClick={onCancel}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="rounded-md bg-danger-fill px-4 py-2 text-[15px] font-medium text-white hover:bg-danger-fill-hover"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
