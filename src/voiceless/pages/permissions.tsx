import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  checkAccessibilityPermission,
  checkInputMonitoringPermission,
  checkMicrophonePermission,
  requestAccessibilityPermission,
  requestInputMonitoringPermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { platform } from "@tauri-apps/plugin-os";
import { Shield } from "lucide-react";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Row, Section, StatusPill } from "../ui";
import { useFnKeyUsage } from "./HomePage";

/**
 * The macOS permission plugin returns `true` for everything on other
 * platforms, so every check below is only meaningful on macOS. Anywhere else
 * these rows would be three permanently-green rows for permissions that do not
 * exist, which is why the UI branches on this.
 */
const IS_MACOS = platform() === "macos";
const IS_WINDOWS = platform() === "windows";

export interface PermissionState {
  microphone: boolean | null;
  accessibility: boolean | null;
  inputMonitoring: boolean | null;
}

/** Poll macOS permissions while mounted (grants happen in System Settings). */
export const usePermissions = (intervalMs = 1500) => {
  const accessibilityRef = useRef(false);
  const [state, setState] = useState<PermissionState>({
    microphone: null,
    accessibility: null,
    inputMonitoring: null,
  });

  const refresh = useCallback(async () => {
    if (!IS_MACOS) {
      // Nothing to poll: these are macOS concepts and the plugin would report
      // a meaningless `true`. Treat them as granted so nothing blocks.
      setState({
        microphone: true,
        accessibility: true,
        inputMonitoring: true,
      });
      return;
    }
    const safe = async (fn: () => Promise<boolean>) => {
      try {
        return await fn();
      } catch {
        return null;
      }
    };
    const [microphone, accessibility, inputMonitoring] = await Promise.all([
      safe(checkMicrophonePermission),
      safe(checkAccessibilityPermission),
      safe(checkInputMonitoringPermission),
    ]);
    // Accessibility unlocks paste and the key listener; initialize both the
    // moment it is granted so shortcuts work without a relaunch.
    if (accessibility && !accessibilityRef.current) {
      void commands.initializeEnigo().catch(() => {});
      void commands.initializeShortcuts().catch(() => {});
    }
    accessibilityRef.current = Boolean(accessibility);
    setState({ microphone, accessibility, inputMonitoring });
  }, []);

  useEffect(() => {
    void refresh();
    // Only macOS grants change behind our back (in System Settings).
    if (!IS_MACOS) return;
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { state, refresh };
};

/**
 * Windows keeps microphone consent in the registry and there is no prompt to
 * trigger, so this reports the state and links to the Settings page.
 */
const WindowsMicrophoneRow: React.FC = () => {
  const { t } = useTranslation();
  const [denied, setDenied] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await commands.getWindowsMicrophonePermissionStatus();
      setDenied(status.supported && status.overall_access === "denied");
    } catch {
      setDenied(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 1500);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Row
      title={t("voiceless.permissions.microphone.title")}
      description={t("voiceless.permissions.microphone.windowsDesc")}
    >
      {denied === false ? (
        <StatusPill ok>{t("voiceless.permissions.granted")}</StatusPill>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void commands.openMicrophonePrivacySettings()}
          >
            {t("voiceless.common.openSystemSettings")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            {t("voiceless.common.recheck")}
          </Button>
        </div>
      )}
    </Row>
  );
};

export const PermissionRows: React.FC<{ state: PermissionState }> = ({
  state,
}) => {
  const { t } = useTranslation();
  if (IS_WINDOWS) return <WindowsMicrophoneRow />;
  // Linux and anything else: no permission model we can report on.
  if (!IS_MACOS) return null;
  const rows = [
    {
      key: "microphone" as const,
      request: requestMicrophonePermission,
      pane: "microphone",
    },
    {
      key: "accessibility" as const,
      request: requestAccessibilityPermission,
      pane: "accessibility",
    },
    {
      key: "inputMonitoring" as const,
      request: requestInputMonitoringPermission,
      pane: "input_monitoring",
    },
  ];

  return (
    <>
      {rows.map((row) => {
        const granted = state[row.key];
        return (
          <Row
            key={row.key}
            title={t(`voiceless.permissions.${row.key}.title`)}
            description={t(`voiceless.permissions.${row.key}.description`)}
          >
            {granted ? (
              <StatusPill ok>{t("voiceless.permissions.granted")}</StatusPill>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={async () => {
                    try {
                      await row.request();
                    } catch {
                      // Fall back to the System Settings pane below.
                    }
                  }}
                >
                  {t("voiceless.permissions.grant")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void commands.openSystemSettingsPane(row.pane)}
                >
                  {t("voiceless.common.openSystemSettings")}
                </Button>
              </div>
            )}
          </Row>
        );
      })}
    </>
  );
};

/** The permissions block, shown inside the Settings page. */
export const PermissionsSection: React.FC = () => {
  const { t } = useTranslation();
  const { state } = usePermissions();
  const { usage, refresh } = useFnKeyUsage();

  return (
    // One flex child of the page, so the hint stays close to its section.
    <div className="flex flex-col gap-3">
      <Section
        icon={<Shield size={20} />}
        title={t("voiceless.permissions.title")}
        description={t("voiceless.permissions.description")}
      >
        <PermissionRows state={state} />
        {/* The Fn/Globe key setting only exists on Apple keyboards. */}
        {IS_MACOS && (
          <Row
            title={t("voiceless.permissions.fn.title")}
            description={
              usage?.compatible
                ? t("voiceless.permissions.fn.ok")
                : t("voiceless.permissions.fn.bad", {
                    action: t(
                      `voiceless.shortcuts.fnActions.${usage?.action ?? "unknown"}`,
                    ),
                  })
            }
          >
            {usage?.compatible ? (
              <StatusPill ok>
                {t("voiceless.shortcuts.fnActions.do_nothing")}
              </StatusPill>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void commands.openSystemSettingsPane("keyboard")
                  }
                >
                  {t("voiceless.shortcuts.fnWarning.open")}
                </Button>
                <Button variant="ghost" size="sm" onClick={refresh}>
                  {t("voiceless.common.recheck")}
                </Button>
              </div>
            )}
          </Row>
        )}
      </Section>
      {IS_MACOS && (
        <p className="text-[13px] text-mid-gray leading-relaxed">
          {t("voiceless.permissions.restartHint")}
        </p>
      )}
    </div>
  );
};
