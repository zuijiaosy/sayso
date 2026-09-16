import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  commands,
  events,
  type FnKeyUsage,
  type ShortcutActivation,
  type UsageDay,
} from "@/bindings";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { Logo } from "../Logo";
import { ShortcutField } from "../ShortcutField";
import { Notice, Page, Row, Section, Segmented } from "../ui";
import { TYPING_BASELINE_CPM, byDay, weekAndSpeed } from "./UsagePage";

export const useFnKeyUsage = () => {
  const [usage, setUsage] = useState<FnKeyUsage | null>(null);
  const refresh = () => {
    commands
      .getFnKeyUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  };
  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return { usage, refresh };
};

const usesFn = (binding?: string) =>
  Boolean(binding?.split("+").some((p) => p.trim().toLowerCase() === "fn"));

export const FnSettingNotice: React.FC<{ usage: FnKeyUsage | null }> = ({
  usage,
}) => {
  const { t } = useTranslation();
  if (!usage || usage.compatible || usage.action === "unknown") return null;
  return (
    <Notice
      tone="warning"
      title={t("voiceless.shortcuts.fnWarning.title")}
      action={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void commands.openSystemSettingsPane("keyboard")}
        >
          {t("voiceless.shortcuts.fnWarning.open")}
        </Button>
      }
    >
      {t("voiceless.shortcuts.fnWarning.body", {
        action: t(`voiceless.shortcuts.fnActions.${usage.action}`),
      })}
    </Notice>
  );
};

const HeroStat: React.FC<{ label: string; value: string; unit?: string }> = ({
  label,
  value,
  unit,
}) => (
  <div className="rounded-control bg-white/15 px-3 py-2.5">
    <div className="text-[11px] leading-4 text-white/80">{label}</div>
    <div className="mt-0.5 text-[20px] leading-7 font-bold tabular-nums">
      {value}
    </div>
    {unit && <div className="text-[10px] leading-3 text-white/70">{unit}</div>}
  </div>
);

/**
 * Brand header for the home page: the mark, the tagline, and the figures that
 * make the case for dictating. The numbers reuse the Usage page's helpers, so
 * the two surfaces can never disagree.
 */
const Hero: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState<UsageDay[]>([]);

  const load = useCallback(async () => {
    const result = await commands.getUsageDays(null);
    if (result.status === "ok") setDays(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen(({ payload }) => {
      if (payload.action === "added") void load();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [load]);

  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );

  const { weekChars, cpm } = useMemo(() => weekAndSpeed(byDay(days)), [days]);

  return (
    <div className="rounded-card p-6 text-white bg-gradient-to-br from-brand-from to-brand-to shadow-pop">
      <div className="flex items-center gap-3">
        <Logo size={36} />
        <div className="font-display text-[24px] leading-8 font-semibold">
          {t("voiceless.tagline")}
        </div>
      </div>
      <p className="mt-2.5 text-[13px] leading-relaxed text-white/85">
        {t("voiceless.home.heroHint")}
      </p>
      {cpm > 0 ? (
        <div className="mt-5 grid grid-cols-3 gap-3">
          <HeroStat
            label={t("voiceless.home.statChars")}
            value={number.format(weekChars)}
          />
          <HeroStat
            label={t("voiceless.home.statSpeed")}
            value={number.format(Math.round(cpm))}
            unit={t("voiceless.usage.speedUnit")}
          />
          <HeroStat
            label={t("voiceless.home.statGain")}
            value={`${Math.round((cpm / TYPING_BASELINE_CPM - 1) * 100)}%`}
          />
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-white/75">
          {t("voiceless.home.statEmpty")}
        </p>
      )}
    </div>
  );
};

export const HomePage: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const { usage } = useFnKeyUsage();

  const anyFn =
    usesFn(settings?.bindings?.transcribe?.current_binding) ||
    usesFn(settings?.bindings?.translate?.current_binding);

  return (
    <Page title={t("voiceless.nav.home")}>
      <Hero />
      {anyFn && <FnSettingNotice usage={usage} />}
      <Section>
        <Row
          title={t("voiceless.shortcuts.dictate.title")}
          description={t("voiceless.shortcuts.dictate.description")}
        >
          <ShortcutField bindingId="transcribe" />
        </Row>
        <Row
          title={t("voiceless.shortcuts.translate.title")}
          description={t("voiceless.shortcuts.translate.description")}
        >
          <ShortcutField bindingId="translate" />
        </Row>
        <Row
          title={t("voiceless.shortcuts.activation.title")}
          description={t("voiceless.shortcuts.activation.description")}
          stacked
        >
          <Segmented<ShortcutActivation>
            value={settings?.shortcut_activation ?? "hold_or_toggle"}
            onChange={(value) =>
              void updateSetting("shortcut_activation", value)
            }
            options={[
              {
                value: "hold_or_toggle",
                label: t("voiceless.shortcuts.activation.hold_or_toggle"),
              },
              {
                value: "toggle",
                label: t("voiceless.shortcuts.activation.toggle"),
              },
              {
                value: "push_to_talk",
                label: t("voiceless.shortcuts.activation.push_to_talk"),
              },
            ]}
          />
        </Row>
      </Section>
      <div className="text-[13px] text-muted leading-relaxed flex flex-col gap-1.5">
        <p>{t("voiceless.shortcuts.tips")}</p>
        {anyFn && <p>{t("voiceless.shortcuts.fnHardware")}</p>}
      </div>
    </Page>
  );
};
