import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * A small centred dialog. Escape, the close button, or a click on the
 * backdrop dismisses it. Rendered into `document.body` so it escapes the
 * scroll containers and hover-revealed rows it is opened from.
 */
export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}> = ({ open, onClose, title, children }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="fixed inset-0 m-0 h-full max-h-none w-full max-w-none open:flex items-center justify-center border-0 bg-transparent p-4 cursor-default backdrop:bg-black/30"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // Without this the browser's own mousedown focus handling runs after
        // the dialog unmounts and moves focus to <body>, undoing the restore.
        event.preventDefault();
        onClose();
      }}
    >
      <div className="w-full max-w-[460px] max-h-[85vh] flex flex-col bg-surface text-text rounded-card shadow-card select-text">
        <div className="shrink-0 flex items-center gap-3 ps-5 pe-3 pt-4 pb-3 border-b border-border">
          <h2
            id={titleId}
            className="flex-1 min-w-0 text-[16px] leading-6 font-semibold tracking-tight"
          >
            {title}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            title={t("voiceless.common.close")}
            aria-label={t("voiceless.common.close")}
            onClick={onClose}
          >
            <X size={14} />
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-5">{children}</div>
      </div>
    </dialog>,
    document.body,
  );
};
