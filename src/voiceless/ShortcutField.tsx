import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { commands } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { SECURE_INPUT_HELP_URL } from "@/components/SecureInputWarning";
import { bindingChips } from "./keys";
import { KeyChip } from "./ui";

interface HandyKeysEvent {
  modifiers: string[];
  key: string | null;
  is_key_down: boolean;
  hotkey_string: string;
}

/**
 * Records a shortcut through the native key listener (handy-keys), which is
 * the only path that can see Fn and tell Left from Right Shift. A keyed combo
 * commits on its key's release; a modifier-only combo (Fn, Fn + Left Shift)
 * commits once every modifier is released.
 */
function useShortcutRecorder() {
  const { t } = useTranslation();
  const { updateBinding, refreshSettings } = useSettings();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const keyedRef = useRef("");
  const modifierOnlyRef = useRef("");

  const stop = useCallback(async () => {
    await commands.stopHandyKeysRecording().catch(() => {});
    setRecordingId(null);
    setPreview("");
    keyedRef.current = "";
    modifierOnlyRef.current = "";
  }, []);

  useEffect(() => {
    if (!recordingId) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const commit = async (keys: string) => {
      try {
        await updateBinding(recordingId, keys);
      } catch (error) {
        toast.error(
          t("voiceless.shortcuts.errors.set", { error: String(error) }),
        );
        await refreshSettings();
      }
      await stop();
    };

    listen<HandyKeysEvent>("handy-keys-event", async (event) => {
      if (disposed) return;
      const { hotkey_string, is_key_down, key, modifiers } = event.payload;
      if (is_key_down && hotkey_string) {
        if (key) keyedRef.current = hotkey_string;
        else modifierOnlyRef.current = hotkey_string;
        setPreview(hotkey_string);
      } else if (!is_key_down && key) {
        const keys = keyedRef.current || hotkey_string;
        if (keys) await commit(keys);
      } else if (
        !is_key_down &&
        !key &&
        modifiers.length === 0 &&
        !keyedRef.current &&
        modifierOnlyRef.current
      ) {
        await commit(modifierOnlyRef.current);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [recordingId, refreshSettings, stop, t, updateBinding]);

  useEffect(
    () => () => {
      void commands.stopHandyKeysRecording().catch(() => {});
    },
    [],
  );

  const start = useCallback(
    async (bindingId: string) => {
      if (recordingId) await stop();
      const result = await commands.startHandyKeysRecording(bindingId);
      if (result.status === "error") {
        if (String(result.error).includes("secure-input-active")) {
          toast.error(t("secureInput.recorderBlocked"), {
            action: {
              label: t("secureInput.learnMore"),
              onClick: () => openUrl(SECURE_INPUT_HELP_URL),
            },
          });
        } else {
          toast.error(
            t("voiceless.shortcuts.errors.set", { error: result.error }),
          );
        }
        return;
      }
      keyedRef.current = "";
      modifierOnlyRef.current = "";
      setPreview("");
      setRecordingId(bindingId);
    },
    [recordingId, stop, t],
  );

  return { recordingId, preview, start, stop };
}

const BindingBox: React.FC<{
  chips: string[];
  recording: boolean;
  placeholder: string;
  onClick: () => void;
  trailing?: React.ReactNode;
}> = ({ chips, recording, placeholder, onClick, trailing }) => (
  <div
    className={`flex items-center gap-2 min-h-[52px] w-[232px] max-w-full ps-2 pe-2 py-2 rounded-2xl border transition-colors ${
      recording
        ? "border-background-ui ring-2 ring-background-ui/20"
        : "border-mid-gray/30 hover:border-mid-gray/60"
    }`}
  >
    <button
      type="button"
      className="flex-1 min-w-0 flex flex-wrap items-center gap-2 text-start cursor-pointer min-h-9"
      onClick={onClick}
    >
      {chips.length > 0 ? (
        chips.map((chip, i) => (
          <KeyChip key={`${chip}-${i}`} label={chip} active={recording} />
        ))
      ) : (
        <span className="text-sm text-mid-gray px-2">{placeholder}</span>
      )}
    </button>
    {trailing}
  </div>
);

/** Each mode has exactly one shortcut; clicking the box records a new one. */
export const ShortcutField: React.FC<{ bindingId: string }> = ({
  bindingId,
}) => {
  const { t } = useTranslation();
  const { settings, resetBinding } = useSettings();
  const { recordingId, preview, start, stop } = useShortcutRecorder();
  const containerRef = useRef<HTMLDivElement>(null);

  const binding = settings?.bindings?.[bindingId];
  const recording = recordingId === bindingId;

  // Click outside cancels recording (the stored binding is untouched).
  useEffect(() => {
    if (!recordingId) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) void stop();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [recordingId, stop]);

  const isDefault =
    !binding || binding.current_binding === binding.default_binding;

  return (
    <div ref={containerRef} className="flex flex-col items-end gap-2">
      <BindingBox
        chips={
          recording
            ? bindingChips(preview)
            : bindingChips(binding?.current_binding)
        }
        recording={recording}
        placeholder={t("voiceless.shortcuts.pressKeys")}
        onClick={() => void start(bindingId)}
        trailing={
          !isDefault && !recording ? (
            <button
              type="button"
              title={t("voiceless.shortcuts.reset")}
              aria-label={t("voiceless.shortcuts.reset")}
              className="shrink-0 p-1.5 rounded-md text-mid-gray hover:text-text hover:bg-mid-gray/15 cursor-pointer"
              onClick={() => void resetBinding(bindingId)}
            >
              <RotateCcw size={15} />
            </button>
          ) : null
        }
      />
    </div>
  );
};
