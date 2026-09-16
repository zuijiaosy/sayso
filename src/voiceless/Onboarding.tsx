import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Cloud, Download, FolderOpen, Loader2 } from "lucide-react";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { useModelStore } from "@/stores/modelStore";
import type { PageId } from "./SettingsShell";
import { importSenseVoiceFolder, SENSE_VOICE_ID } from "./pages/ModelsPage";
import { PermissionRows, usePermissions } from "./pages/permissions";
import { FnSettingNotice, useFnKeyUsage } from "./pages/HomePage";
import { Section } from "./ui";

const Choice: React.FC<{
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  trailing?: React.ReactNode;
}> = ({ icon, title, description, onClick, disabled, trailing }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="w-full flex items-center gap-4 p-4 rounded-2xl border border-mid-gray/25 hover:border-background-ui hover:bg-background-ui/5 text-start cursor-pointer disabled:cursor-default disabled:opacity-70 transition-colors"
  >
    <span className="w-10 h-10 shrink-0 rounded-xl bg-mid-gray/10 grid place-items-center text-text/80">
      {icon}
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-[15px] font-semibold">{title}</span>
      <span className="block text-[13px] text-mid-gray mt-0.5 leading-relaxed">
        {description}
      </span>
    </span>
    {trailing && <span className="shrink-0">{trailing}</span>}
  </button>
);

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="h-screen overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] bg-background text-text select-none">
    <div className="w-full max-w-[560px] mx-auto px-8 pt-10 pb-12">
      {children}
    </div>
  </div>
);

export const Onboarding: React.FC<{ onDone: (page: PageId) => void }> = ({
  onDone,
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<"permissions" | "model">("permissions");
  const { state } = usePermissions();
  const { usage } = useFnKeyUsage();
  const { updateSetting } = useSettings();
  const {
    models,
    downloadModel,
    selectModel,
    downloadingModels,
    downloadProgress,
    verifyingModels,
    extractingModels,
  } = useModelStore();
  const [pending, setPending] = useState<
    "download" | "import" | "cloud" | null
  >(null);
  const finishing = useRef(false);

  const senseVoice = models.find((m) => m.id === SENSE_VOICE_ID);
  const downloading = SENSE_VOICE_ID in downloadingModels;
  const busyAfterDownload =
    SENSE_VOICE_ID in verifyingModels || SENSE_VOICE_ID in extractingModels;
  const percent = Math.round(downloadProgress[SENSE_VOICE_ID]?.percentage ?? 0);

  const canContinue = Boolean(state.microphone && state.accessibility);

  const useLocal = async () => {
    if (finishing.current) return;
    finishing.current = true;
    await updateSetting("asr_provider", "local");
    const ok = await selectModel(SENSE_VOICE_ID);
    if (!ok) {
      finishing.current = false;
      setPending(null);
      toast.error(useModelStore.getState().error ?? "");
      return;
    }
    onDone("home");
  };

  // Finish once the requested download has landed (verified and extracted).
  useEffect(() => {
    if (
      pending === "download" &&
      senseVoice?.is_downloaded &&
      !downloading &&
      !busyAfterDownload
    ) {
      void useLocal();
    }
  }, [pending, senseVoice?.is_downloaded, downloading, busyAfterDownload]);

  if (step === "permissions") {
    return (
      <Frame>
        <h1 className="text-[28px] leading-9 font-bold tracking-tight">
          {t("voiceless.onboarding.welcome")}
        </h1>
        <p className="text-sm text-mid-gray mt-1.5 leading-relaxed">
          {t("voiceless.onboarding.subtitle")}
        </p>
        <div className="mt-8">
          <Section title={t("voiceless.onboarding.stepPermissions")}>
            <PermissionRows state={state} />
          </Section>
        </div>
        <div className="mt-4">
          <FnSettingNotice usage={usage} />
        </div>
        <p className="text-[13px] text-mid-gray mt-4 leading-relaxed">
          {t("voiceless.permissions.restartHint")}
        </p>
        <div className="mt-6 flex justify-end">
          <Button
            variant="primary"
            size="lg"
            disabled={!canContinue}
            onClick={() => setStep("model")}
          >
            {t("voiceless.onboarding.continue")}
          </Button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 className="text-[28px] leading-9 font-bold tracking-tight">
        {t("voiceless.onboarding.welcome")}
      </h1>
      <div className="mt-8">
        <Section title={t("voiceless.onboarding.stepModel")}>
          <div className="py-4 flex flex-col gap-3">
            <Choice
              icon={<Download size={20} />}
              title={t("voiceless.onboarding.download")}
              description={t("voiceless.onboarding.downloadDesc")}
              disabled={pending !== null}
              onClick={() => {
                setPending("download");
                if (!senseVoice?.is_downloaded)
                  void downloadModel(SENSE_VOICE_ID);
              }}
              trailing={
                pending === "download" ? (
                  <span className="flex items-center gap-2 whitespace-nowrap text-[13px] text-mid-gray tabular-nums">
                    <Loader2 size={15} className="animate-spin" />
                    {downloading
                      ? t("voiceless.models.local.downloading", { percent })
                      : t("voiceless.onboarding.finishing")}
                  </span>
                ) : null
              }
            />
            <Choice
              icon={<FolderOpen size={20} />}
              title={t("voiceless.onboarding.import")}
              description={t("voiceless.onboarding.importDesc")}
              disabled={pending !== null}
              onClick={async () => {
                setPending("import");
                const ok = await importSenseVoiceFolder(t);
                if (ok) {
                  await updateSetting("asr_provider", "local");
                  onDone("home");
                } else {
                  setPending(null);
                }
              }}
            />
            <Choice
              icon={<Cloud size={20} />}
              title={t("voiceless.onboarding.cloud")}
              description={t("voiceless.onboarding.cloudDesc")}
              disabled={pending !== null}
              onClick={async () => {
                setPending("cloud");
                await updateSetting("asr_provider", "cloud");
                await commands.completeOnboarding();
                onDone("models");
              }}
            />
          </div>
        </Section>
      </div>
      <div className="mt-2 flex justify-start">
        <Button
          variant="ghost"
          onClick={() => setStep("permissions")}
          disabled={pending !== null}
        >
          {t("voiceless.onboarding.back")}
        </Button>
      </div>
    </Frame>
  );
};
