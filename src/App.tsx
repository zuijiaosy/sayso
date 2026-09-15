import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast, Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { ModelStateEvent, RecordingErrorEvent } from "./lib/types/events";
import "./App.css";
import { useSettings } from "./hooks/useSettings";
import { commands } from "@/bindings";
import { initializeRTL } from "@/lib/utils/rtl";
import { Onboarding } from "./voiceless/Onboarding";
import { SettingsShell, type PageId } from "./voiceless/SettingsShell";

type Phase = "loading" | "onboarding" | "ready";

function App() {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [page, setPage] = useState<PageId>("shortcuts");
  const { refreshAudioDevices, refreshOutputDevices, refreshSettings } =
    useSettings();
  const initialized = useRef(false);

  useEffect(() => {
    initializeRTL(i18n.language);
  }, [i18n.language]);

  // Decide between first-run onboarding and the settings window.
  useEffect(() => {
    const check = async () => {
      try {
        const result = await commands.getAppSettings();
        const completed =
          result.status === "ok" && result.data.onboarding_completed === true;
        if (!completed) {
          setPhase("onboarding");
          return;
        }
        if (platform() === "macos") {
          const [accessibility, microphone] = await Promise.all([
            checkAccessibilityPermission().catch(() => true),
            checkMicrophonePermission().catch(() => true),
          ]);
          if (!accessibility || !microphone) {
            setPage("permissions");
            await commands.showMainWindowCommand().catch(() => {});
          }
        }
        setPhase("ready");
      } catch (error) {
        console.error("Failed to check onboarding status:", error);
        setPhase("onboarding");
      }
    };
    void check();
  }, []);

  // Enigo (paste) and the shortcut listener start once setup is done, so the
  // permission prompts they can trigger never appear before onboarding.
  useEffect(() => {
    if (phase !== "ready" || initialized.current) return;
    initialized.current = true;
    Promise.all([
      commands.initializeEnigo(),
      commands.initializeShortcuts(),
    ]).catch((e) => console.warn("Failed to initialize:", e));
    void refreshAudioDevices();
    void refreshOutputDevices();
  }, [phase, refreshAudioDevices, refreshOutputDevices]);

  useEffect(() => {
    const unlisten = listen<RecordingErrorEvent>("recording-error", (event) => {
      const { error_type, detail } = event.payload;
      if (error_type === "microphone_permission_denied") {
        const description = t(`errors.micPermissionDenied.${platform()}`, {
          defaultValue: t("errors.micPermissionDenied.generic"),
        });
        toast.error(t("errors.micPermissionDeniedTitle"), { description });
      } else if (error_type === "no_input_device") {
        toast.error(t("errors.noInputDeviceTitle"), {
          description: t("errors.noInputDevice"),
        });
      } else {
        toast.error(t("errors.recordingFailed", { error: detail ?? "" }));
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  useEffect(() => {
    const unlisten = listen("paste-error", () => {
      toast.error(t("errors.pasteFailedTitle"), {
        description: t("errors.pasteFailed"),
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  useEffect(() => {
    const unlisten = listen<string>("transcription-error", (event) => {
      toast.error(t("errors.transcriptionFailedTitle"), {
        description: event.payload,
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  useEffect(() => {
    const unlisten = listen<ModelStateEvent>("model-state-changed", (event) => {
      if (event.payload.event_type === "loading_failed") {
        toast.error(
          t("errors.modelLoadFailed", {
            model:
              event.payload.model_name || t("errors.modelLoadFailedUnknown"),
          }),
          { description: event.payload.error },
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t]);

  const toaster = (
    <Toaster
      theme="system"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "bg-background border border-mid-gray/20 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 text-sm",
          title: "font-medium",
          description: "text-mid-gray",
          actionButton:
            "px-2 py-1 text-xs font-medium rounded-lg border bg-mid-gray/10 border-mid-gray/20 hover:bg-mid-gray/20 cursor-pointer whitespace-nowrap",
        },
      }}
    />
  );

  let content: ReactNode = null;
  if (phase === "onboarding") {
    content = (
      <Onboarding
        onDone={(nextPage) => {
          setPage(nextPage);
          void refreshSettings();
          setPhase("ready");
        }}
      />
    );
  } else if (phase === "ready") {
    content = <SettingsShell page={page} onPageChange={setPage} />;
  }

  return (
    <>
      {toaster}
      {content}
    </>
  );
}

export default App;
