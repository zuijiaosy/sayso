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
import { Shield } from "lucide-react";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Row, Section, StatusPill } from "../ui";
import { useFnKeyUsage } from "./HomePage";

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
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { state, refresh };
};

export const PermissionRows: React.FC<{ state: PermissionState }> = ({
  state,
}) => {
  const { t } = useTranslation();
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
                onClick={() => void commands.openSystemSettingsPane("keyboard")}
              >
                {t("voiceless.shortcuts.fnWarning.open")}
              </Button>
              <Button variant="ghost" size="sm" onClick={refresh}>
                {t("voiceless.common.recheck")}
              </Button>
            </div>
          )}
        </Row>
      </Section>
      <p className="text-[13px] text-mid-gray leading-relaxed">
        {t("voiceless.permissions.restartHint")}
      </p>
    </div>
  );
};
