import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { Share2 } from "lucide-react";
import { commands, events, type SessionMode, type UsageDay } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { Page, Segmented } from "../ui";

/** Typing speed the "faster than typing" figure is measured against. */
export const TYPING_BASELINE_CPM = 40;
/** Weeks shown in the activity grid. */
const HEATMAP_WEEKS = 20;

type Filter = "all" | SessionMode;

interface DayTotals {
  sessions: number;
  chars: number;
  audioMs: number;
}

const EMPTY: DayTotals = { sessions: 0, chars: 0, audioMs: 0 };

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

const parseDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
};

/** Local-time date arithmetic: the Date constructor handles month, year and
 * DST boundaries, which raw millisecond math does not. */
const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** Monday-based week start, matching the "this week" figures. */
const startOfWeek = (date: Date) => addDays(date, -((date.getDay() + 6) % 7));

const sum = (totals: DayTotals[]): DayTotals =>
  totals.reduce(
    (acc, day) => ({
      sessions: acc.sessions + day.sessions,
      chars: acc.chars + day.chars,
      audioMs: acc.audioMs + day.audioMs,
    }),
    EMPTY,
  );

/** Collapse the per-mode rows into one entry per calendar day. */
export const byDay = (days: UsageDay[]): Map<string, DayTotals> => {
  const out = new Map<string, DayTotals>();
  for (const day of days) {
    const previous = out.get(day.day) ?? EMPTY;
    out.set(day.day, {
      sessions: previous.sessions + day.sessions,
      chars: previous.chars + day.chars,
      audioMs: previous.audioMs + day.audio_ms,
    });
  }
  return out;
};

/**
 * This week's character count and the overall speaking speed in characters per
 * minute. Shared with the home page hero so the two surfaces cannot disagree.
 */
export const weekAndSpeed = (totals: Map<string, DayTotals>) => {
  const all = sum([...totals.values()]);
  const weekStart = dayKey(startOfWeek(new Date()));
  const week = sum(
    [...totals.entries()]
      .filter(([day]) => day >= weekStart)
      .map(([, value]) => value),
  );
  return {
    weekChars: week.chars,
    cpm: all.audioMs > 0 ? all.chars / (all.audioMs / 60_000) : 0,
  };
};

/** Consecutive active days ending today (or yesterday, while today is still
 * unused), plus the longest such run ever. */
export const streaks = (active: Set<string>) => {
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of [...active].sort()) {
    run =
      previous && dayKey(addDays(parseDay(previous), 1)) === day ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }

  let cursor = new Date();
  if (!active.has(dayKey(cursor))) cursor = addDays(cursor, -1);
  let current = 0;
  while (active.has(dayKey(cursor))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  return { current, longest };
};

/**
 * Card washes for the metric grid. Each tile gets its own hue so the six
 * numbers read as distinct facts rather than one undifferentiated table; the
 * tints are mixed over the surface at `--tint-strength` so they stay legible in
 * both themes.
 */
const TINTS = [
  "--color-tint-peach",
  "--color-tint-butter",
  "--color-tint-sage",
  "--color-tint-sky",
  "--color-tint-lilac",
  "--color-tint-rose",
] as const;

type Tint = (typeof TINTS)[number];

const Metric: React.FC<{
  label: string;
  value: string;
  hint?: string;
  tint: Tint;
}> = ({ label, value, hint, tint }) => (
  <div
    className="rounded-card px-4 py-3.5 shadow-card"
    style={{
      background: `color-mix(in srgb, var(${tint}) var(--tint-strength), var(--color-surface))`,
    }}
  >
    <div className="text-[12px] text-muted">{label}</div>
    <div className="mt-1 text-[24px] leading-8 font-bold tabular-nums tracking-tight">
      {value}
    </div>
    {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
  </div>
);

const levelFor = (chars: number) => {
  if (chars <= 0) return 0;
  if (chars < 200) return 1;
  if (chars < 800) return 2;
  return 3;
};

const LEVEL_CLASS = ["bg-border", "bg-accent/30", "bg-accent/60", "bg-accent"];

const Heatmap: React.FC<{ totals: Map<string, DayTotals> }> = ({ totals }) => {
  const { t, i18n } = useTranslation();

  const weeks = useMemo(() => {
    const thisWeek = startOfWeek(new Date());
    return Array.from({ length: HEATMAP_WEEKS }, (_, column) => {
      const monday = addDays(thisWeek, (column - HEATMAP_WEEKS + 1) * 7);
      return Array.from({ length: 7 }, (_, row) => addDays(monday, row));
    });
  }, []);

  const weekdayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { weekday: "short" }),
    [i18n.language],
  );
  const monthFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: "short" }),
    [i18n.language],
  );
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }),
    [i18n.language],
  );

  const today = dayKey(new Date());

  return (
    <div className="flex gap-2 overflow-x-auto">
      <div className="shrink-0 flex flex-col gap-1 pt-0.5">
        {weeks[0].map((date, row) => (
          <span
            key={row}
            className="h-3 text-[10px] leading-3 text-muted text-end"
          >
            {row % 2 === 0 ? weekdayFormat.format(date) : ""}
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        {weeks.map((week, column) => {
          const previousMonth =
            column > 0 ? weeks[column - 1][0].getMonth() : -1;
          const showMonth = week[0].getMonth() !== previousMonth;
          return (
            <div key={column} className="flex flex-col gap-1">
              {week.map((date) => {
                const key = dayKey(date);
                const chars = totals.get(key)?.chars ?? 0;
                const future = key > today;
                return (
                  <span
                    key={key}
                    title={`${dayFormat.format(date)} · ${t(
                      "voiceless.usage.charsUnit",
                      { count: chars },
                    )}`}
                    className={`w-3 h-3 rounded-pill ${
                      future ? "bg-transparent" : LEVEL_CLASS[levelFor(chars)]
                    }`}
                  />
                );
              })}
              <span className="h-3 text-[10px] leading-3 text-muted">
                {showMonth ? monthFormat.format(week[0]) : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const UsagePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const [days, setDays] = useState<UsageDay[]>([]);

  const mode: SessionMode | null = filter === "all" ? null : filter;

  const load = useCallback(async () => {
    const result = await commands.getUsageDays(mode);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    setDays(result.data);
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new transcription lands in usage_daily; refresh so the page stays live.
  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen(({ payload }) => {
      if (payload.action === "added") void load();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [load]);

  const totals = useMemo(() => byDay(days), [days]);

  const stats = useMemo(() => {
    const all = sum([...totals.values()]);
    const active = new Set(
      [...totals.entries()]
        .filter(([, value]) => value.sessions > 0)
        .map(([day]) => day),
    );
    const dictateChars = days
      .filter((day) => day.mode === "dictate")
      .reduce((acc, day) => acc + day.chars, 0);
    const { weekChars, cpm } = weekAndSpeed(totals);

    return {
      all,
      weekChars,
      cpm,
      dictateShare: all.chars > 0 ? dictateChars / all.chars : 0,
      activeDays: active.size,
      ...streaks(active),
    };
  }, [totals, days]);

  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );

  const duration = useCallback(
    (ms: number) => {
      const minutes = Math.round(ms / 60_000);
      if (minutes < 60) return t("voiceless.usage.minutes", { count: minutes });
      return t("voiceless.usage.hoursMinutes", {
        hours: Math.floor(minutes / 60),
        minutes: minutes % 60,
      });
    },
    [t],
  );

  const speed = stats.cpm > 0 ? number.format(Math.round(stats.cpm)) : "—";
  const gain =
    stats.cpm > 0
      ? `${Math.round((stats.cpm / TYPING_BASELINE_CPM - 1) * 100)}%`
      : "—";

  const share = async () => {
    await writeText(
      t("voiceless.usage.shareText", {
        chars: number.format(stats.all.chars),
        speed,
        gain,
        streak: stats.current,
      }),
    );
    toast.success(t("voiceless.common.copied"));
  };

  return (
    <Page title={t("voiceless.nav.usage")}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t("voiceless.history.filterAll") },
              { value: "dictate", label: t("voiceless.history.filterDictate") },
              {
                value: "translate",
                label: t("voiceless.history.filterTranslate"),
              },
            ]}
          />
          <Button variant="secondary" size="sm" onClick={() => void share()}>
            <Share2 size={14} />
            {t("voiceless.usage.share")}
          </Button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Metric
            label={t("voiceless.usage.weekChars")}
            value={number.format(stats.weekChars)}
            hint={
              filter === "all" && stats.all.chars > 0
                ? t("voiceless.usage.split", {
                    dictate: Math.round(stats.dictateShare * 100),
                    translate: 100 - Math.round(stats.dictateShare * 100),
                  })
                : undefined
            }
            tint={"--color-tint-peach"}
          />
          <Metric
            label={t("voiceless.usage.totalChars")}
            value={number.format(stats.all.chars)}
            tint={"--color-tint-butter"}
          />
          <Metric
            label={t("voiceless.usage.sessions")}
            value={number.format(stats.all.sessions)}
            tint={"--color-tint-sage"}
          />
          <Metric
            label={t("voiceless.usage.duration")}
            value={duration(stats.all.audioMs)}
            tint={"--color-tint-sky"}
          />
          <Metric
            label={t("voiceless.usage.speed")}
            value={speed}
            hint={t("voiceless.usage.speedUnit")}
            tint={"--color-tint-lilac"}
          />
          <Metric
            label={t("voiceless.usage.gain")}
            value={gain}
            hint={t("voiceless.usage.gainHint", {
              baseline: TYPING_BASELINE_CPM,
            })}
            tint={"--color-tint-rose"}
          />
        </div>

        <div className="rounded-card bg-surface shadow-card px-4 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-3">
            <h2 className="text-[14px] font-semibold">
              {t("voiceless.usage.activeDays", { count: stats.activeDays })}
            </h2>
            <span className="text-[12px] text-muted">
              {t("voiceless.usage.streak", {
                current: stats.current,
                longest: stats.longest,
              })}
            </span>
          </div>
          <Heatmap totals={totals} />
          <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-muted">
            <span>{t("voiceless.usage.less")}</span>
            {LEVEL_CLASS.map((className) => (
              <span
                key={className}
                className={`w-2.5 h-2.5 rounded-pill ${className}`}
              />
            ))}
            <span>{t("voiceless.usage.more")}</span>
          </div>
        </div>
      </div>
    </Page>
  );
};
