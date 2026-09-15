import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { exit } from "@tauri-apps/plugin-process";
import { Info, SlidersHorizontal } from "lucide-react";
import { commands, type TranslateTarget } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { Page, Row, Section, SelectInput, Switch } from "../ui";

export const languageLabel = (code: string, uiLanguage: string) => {
  try {
    return (
      new Intl.DisplayNames([uiLanguage, "en"], { type: "language" }).of(
        code,
      ) ?? code
    );
  } catch {
    return code;
  }
};

export const GeneralPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { settings, updateSetting, audioDevices, refreshAudioDevices } =
    useSettings();
  const [targets, setTargets] = useState<TranslateTarget[]>([]);
  const [version, setVersion] = useState("");

  useEffect(() => {
    commands
      .listTranslateTargets()
      .then(setTargets)
      .catch(() => {});
    getVersion()
      .then(setVersion)
      .catch(() => {});
    void refreshAudioDevices();
  }, [refreshAudioDevices]);

  if (!settings) return null;

  return (
    <Page title={t("voiceless.general.title")}>
      <Section
        icon={<SlidersHorizontal size={20} />}
        title={t("voiceless.general.title")}
      >
        <Row
          title={t("voiceless.general.autostart")}
          description={t("voiceless.general.autostartDesc")}
        >
          <Switch
            checked={settings.autostart_enabled ?? false}
            onChange={(checked) =>
              void updateSetting("autostart_enabled", checked)
            }
          />
        </Row>
        <Row
          title={t("voiceless.general.targetLanguage")}
          description={t("voiceless.general.targetLanguageDesc")}
        >
          <SelectInput
            value={settings.translate_target_language}
            onChange={(e) =>
              void updateSetting("translate_target_language", e.target.value)
            }
          >
            {targets.map((target) => (
              <option key={target.code} value={target.code}>
                {languageLabel(target.code, i18n.language)}
              </option>
            ))}
          </SelectInput>
        </Row>
        <Row
          title={t("voiceless.general.microphone")}
          description={t("voiceless.general.microphoneDesc")}
        >
          <SelectInput
            value={settings.selected_microphone ?? "Default"}
            onChange={(e) =>
              void updateSetting("selected_microphone", e.target.value)
            }
          >
            {audioDevices.map((device) => (
              <option key={device.index} value={device.name}>
                {device.name}
              </option>
            ))}
          </SelectInput>
        </Row>
        <Row title={t("voiceless.general.overlayPosition")}>
          <SelectInput
            value={settings.overlay_position}
            onChange={(e) =>
              void updateSetting(
                "overlay_position",
                e.target.value as typeof settings.overlay_position,
              )
            }
          >
            <option value="bottom">
              {t("voiceless.general.overlayBottom")}
            </option>
            <option value="top">{t("voiceless.general.overlayTop")}</option>
          </SelectInput>
        </Row>
        <Row
          title={t("voiceless.general.clipboard")}
          description={t("voiceless.general.clipboardDesc")}
        >
          <Switch
            checked={settings.clipboard_handling === "copy_to_clipboard"}
            onChange={(checked) =>
              void updateSetting(
                "clipboard_handling",
                checked ? "copy_to_clipboard" : "dont_modify",
              )
            }
          />
        </Row>
        <Row title={t("voiceless.general.appLanguage")}>
          <SelectInput
            value={settings.app_language}
            onChange={(e) => {
              void i18n.changeLanguage(e.target.value);
              void updateSetting("app_language", e.target.value);
            }}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName}
              </option>
            ))}
          </SelectInput>
        </Row>
      </Section>

      <Section icon={<Info size={20} />} title={t("voiceless.general.about")}>
        <Row
          title={t("voiceless.appName")}
          description={
            <>
              {t("voiceless.general.version", { version })}
              <br />
              {t("voiceless.general.basedOn")}
            </>
          }
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void commands.openLogDir()}
            >
              {t("voiceless.general.openLogs")}
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={() => void exit(0)}
            >
              {t("voiceless.general.quit")}
            </Button>
          </div>
        </Row>
      </Section>
    </Page>
  );
};
