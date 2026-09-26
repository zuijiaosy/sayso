import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { Info, Shield, SlidersHorizontal } from "lucide-react";
import { commands, type Theme, type TranslateTarget } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { RELEASES_URL, checkForUpdate, type UpdateInfo } from "@/lib/updates";
import { THEME_OPTIONS, applyTheme } from "@/lib/utils/theme";
import {
  Page,
  Row,
  Segmented,
  SelectInput,
  Switch,
  TabbedSection,
} from "../ui";
import { Logo } from "../Logo";
import { PermissionsBody } from "./permissions";

type SettingsTab = "general" | "permissions" | "about";

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

type UpdateState =
  | { status: "idle" | "checking" | "error" }
  | { status: "done"; info: UpdateInfo };

/**
 * Manual "check for updates" in About. Nothing is downloaded or installed in
 * the app: a newer release opens its installer in the browser.
 */
const UpdateRow: React.FC<{ version: string }> = ({ version }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<UpdateState>({ status: "idle" });

  const check = async () => {
    setState({ status: "checking" });
    try {
      setState({ status: "done", info: await checkForUpdate(version) });
    } catch {
      setState({ status: "error" });
    }
  };

  let description: string;
  let action: React.ReactNode;
  if (state.status === "done" && state.info.newer) {
    const { info } = state;
    description = t("sayso.general.update.available", {
      version: info.version,
    });
    action = (
      <Button
        variant="primary"
        size="sm"
        onClick={() => void openUrl(info.downloadUrl)}
      >
        {t("sayso.general.update.download")}
      </Button>
    );
  } else {
    description =
      state.status === "done"
        ? t("sayso.general.update.latest")
        : state.status === "error"
          ? t("sayso.general.update.failed")
          : t("sayso.general.update.description");
    action = (
      <div className="flex flex-wrap justify-end gap-2">
        {state.status === "error" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void openUrl(RELEASES_URL)}
          >
            {t("sayso.general.update.openReleases")}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={!version || state.status === "checking"}
          onClick={() => void check()}
        >
          {state.status === "checking"
            ? t("sayso.general.update.checking")
            : t("sayso.general.update.check")}
        </Button>
      </div>
    );
  }

  return (
    <Row title={t("sayso.general.update.title")} description={description}>
      {action}
    </Row>
  );
};

/** General preferences, permissions and About, reached from the sidebar's
 * bottom gear button. */
export const SettingsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { settings, updateSetting, audioDevices, refreshAudioDevices } =
    useSettings();
  const [targets, setTargets] = useState<TranslateTarget[]>([]);
  const [version, setVersion] = useState("");
  // Must stay above the `!settings` early return: hooks run in a fixed order.
  const [tab, setTab] = useState<SettingsTab>("general");

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
    <Page title={t("sayso.settings.title")}>
      <TabbedSection<SettingsTab>
        value={tab}
        onChange={setTab}
        tabs={[
          {
            value: "general",
            label: t("sayso.general.title"),
            icon: <SlidersHorizontal size={20} />,
          },
          {
            value: "permissions",
            label: t("sayso.permissions.title"),
            icon: <Shield size={20} />,
            description: t("sayso.permissions.description"),
          },
          {
            value: "about",
            label: t("sayso.general.about"),
            icon: <Info size={20} />,
          },
        ]}
      >
        {tab === "general" && (
          <>
            <Row
              title={t("sayso.general.autostart")}
              description={t("sayso.general.autostartDesc")}
            >
              <Switch
                checked={settings.autostart_enabled ?? false}
                onChange={(checked) =>
                  void updateSetting("autostart_enabled", checked)
                }
              />
            </Row>
            <Row
              title={t("sayso.general.targetLanguage")}
              description={t("sayso.general.targetLanguageDesc")}
            >
              <SelectInput
                value={settings.translate_target_language}
                onChange={(e) =>
                  void updateSetting(
                    "translate_target_language",
                    e.target.value,
                  )
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
              title={t("sayso.general.microphone")}
              description={t("sayso.general.microphoneDesc")}
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
            <Row title={t("sayso.general.overlayPosition")}>
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
                  {t("sayso.general.overlayBottom")}
                </option>
                <option value="top">{t("sayso.general.overlayTop")}</option>
              </SelectInput>
            </Row>
            <Row
              title={t("sayso.general.clipboard")}
              description={t("sayso.general.clipboardDesc")}
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
            <Row title={t("sayso.general.appearance")}>
              <Segmented<Theme>
                value={settings.theme ?? "system"}
                onChange={(value) => {
                  // Apply immediately so the window repaints without waiting on the
                  // settings round-trip; the store call persists it.
                  applyTheme(value);
                  void updateSetting("theme", value);
                }}
                options={THEME_OPTIONS.map((option) => ({
                  value: option,
                  label: t(
                    `sayso.general.appearance${
                      option.charAt(0).toUpperCase() + option.slice(1)
                    }`,
                  ),
                }))}
              />
            </Row>
            <Row title={t("sayso.general.appLanguage")}>
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
          </>
        )}

        {tab === "permissions" && <PermissionsBody />}

        {tab === "about" && (
          <>
            <Row
              title={
                <span className="flex items-center gap-2">
                  <Logo size={18} />
                  {t("sayso.appName")}
                </span>
              }
              description={
                <>
                  {t("sayso.general.version", { version })}
                  <br />
                  {t("sayso.general.basedOn")}
                </>
              }
            >
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void commands.openLogDir()}
                >
                  {t("sayso.general.openLogs")}
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => void exit(0)}
                >
                  {t("sayso.general.quit")}
                </Button>
              </div>
            </Row>
            <UpdateRow version={version} />
          </>
        )}
      </TabbedSection>
    </Page>
  );
};
