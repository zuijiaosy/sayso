import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { Copy, Info, Search, Trash2 } from "lucide-react";
import {
  commands,
  events,
  type HistoryEntry,
  type SessionMode,
} from "@/bindings";
import { Button } from "@/components/ui/Button";
import { ProviderIcon, useProviderNames } from "../ProviderIcon";
import { Chip, Page, Segmented, TextInput } from "../ui";
import { HistoryDetailsModal } from "./HistoryDetailsModal";

const PAGE_SIZE = 50;

type Filter = "all" | SessionMode;

/** What actually got typed: post-processing wins when it ran. */
export const finalText = (entry: HistoryEntry) =>
  entry.post_processed_text ?? entry.transcription_text;

const dayKey = (timestamp: number) => {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * Which recognizer and text model produced an entry, as one or two small
 * brand marks. Entries saved before routes were recorded leave it blank.
 */
const RouteIcons: React.FC<{ entry: HistoryEntry }> = ({ entry }) => {
  const { providerName, modelName } = useProviderNames();
  const describe = (
    provider: string,
    model: string | null,
    kind: "asr" | "llm",
  ) =>
    [providerName(provider, kind), modelName(provider, model)]
      .filter(Boolean)
      .join(" · ");

  // Fixed width fits two marks, so the text column lines up across rows
  // with one, two or no icons.
  return (
    <span className="shrink-0 w-[34px] flex items-center gap-1.5 pt-[3px] text-muted">
      {entry.asr && (
        <ProviderIcon
          id={entry.asr.provider}
          title={describe(entry.asr.provider, entry.asr.model, "asr")}
        />
      )}
      {entry.llm && (
        <ProviderIcon
          id={entry.llm.provider}
          title={describe(entry.llm.provider, entry.llm.model, "llm")}
        />
      )}
    </span>
  );
};

/** "Today" / "Yesterday" / a localized date, for the list's day separators. */
const useDayLabel = () => {
  const { t, i18n } = useTranslation();
  const format = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: "long",
        day: "numeric",
      }),
    [i18n.language],
  );

  return useCallback(
    (timestamp: number) => {
      const date = new Date(timestamp * 1000);
      const days = Math.round(
        (startOfDay(new Date()) - startOfDay(date)) / 86_400_000,
      );
      if (days === 0) return t("voiceless.history.today");
      if (days === 1) return t("voiceless.history.yesterday");
      return format.format(date);
    },
    [format, t],
  );
};

const EntryRow: React.FC<{ entry: HistoryEntry; showMode: boolean }> = ({
  entry,
  showMode,
}) => {
  const { t, i18n } = useTranslation();
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [i18n.language],
  );
  const text = finalText(entry);
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div className="group flex items-start gap-3 py-3">
      <span className="shrink-0 w-11 pt-0.5 text-[12px] tabular-nums text-muted">
        {timeFormat.format(new Date(entry.timestamp * 1000))}
      </span>
      <RouteIcons entry={entry} />
      <div className="flex-1 min-w-0 text-[14px] leading-relaxed break-words">
        {text.trim() ? (
          <span className="select-text">{text}</span>
        ) : (
          <span className="text-muted italic">
            {t("voiceless.history.failed")}
          </span>
        )}
        {showMode && entry.mode === "translate" && (
          <span className="ms-2 align-middle">
            <Chip>{t("voiceless.history.filterTranslate")}</Chip>
          </span>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="sm"
          title={t("voiceless.history.details")}
          aria-label={t("voiceless.history.details")}
          onClick={() => setDetailsOpen(true)}
        >
          <Info size={14} />
        </Button>
        {text.trim() && (
          <Button
            variant="ghost"
            size="sm"
            title={t("voiceless.history.copy")}
            aria-label={t("voiceless.history.copy")}
            onClick={async () => {
              await writeText(text);
              toast.success(t("voiceless.common.copied"));
            }}
          >
            <Copy size={14} />
          </Button>
        )}
        <Button
          variant="danger-ghost"
          size="sm"
          title={t("voiceless.common.delete")}
          aria-label={t("voiceless.common.delete")}
          onClick={async () => {
            const result = await commands.deleteHistoryEntry(entry.id);
            if (result.status === "error") toast.error(result.error);
          }}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      <HistoryDetailsModal
        entry={entry}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
      />
    </div>
  );
};

export const HistoryPage: React.FC = () => {
  const { t } = useTranslation();
  const dayLabel = useDayLabel();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  // Only the newest request may write to state; filter changes race otherwise.
  const requestId = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setSearch(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  const mode: SessionMode | null = filter === "all" ? null : filter;

  const load = useCallback(
    async (cursor: number | null) => {
      const id = ++requestId.current;
      setLoading(true);
      const result = await commands.getHistoryEntries(
        cursor,
        PAGE_SIZE,
        mode,
        search || null,
      );
      if (id !== requestId.current) return;
      setLoading(false);
      if (result.status === "error") {
        toast.error(result.error);
        return;
      }
      setEntries((previous) =>
        cursor === null
          ? result.data.entries
          : [...previous, ...result.data.entries],
      );
      setHasMore(result.data.has_more);
    },
    [mode, search],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  // Keep the list live while the user dictates with the window open.
  useEffect(() => {
    const matchesFilter = (entry: HistoryEntry) => {
      if (mode && entry.mode !== mode) return false;
      if (!search) return true;
      const needle = search.toLowerCase();
      return (
        finalText(entry).toLowerCase().includes(needle) ||
        entry.transcription_text.toLowerCase().includes(needle)
      );
    };

    const unlisten = events.historyUpdatePayload.listen(({ payload }) => {
      if (payload.action === "added") {
        if (matchesFilter(payload.entry)) {
          setEntries((previous) => [payload.entry, ...previous]);
        }
      } else if (payload.action === "updated") {
        setEntries((previous) =>
          previous.map((entry) =>
            entry.id === payload.entry.id ? payload.entry : entry,
          ),
        );
      } else if (payload.action === "deleted") {
        setEntries((previous) =>
          previous.filter((entry) => entry.id !== payload.id),
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [mode, search]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: HistoryEntry[] }[] = [];
    for (const entry of entries) {
      const key = dayKey(entry.timestamp);
      const last = out[out.length - 1];
      if (last?.key === key) last.items.push(entry);
      else out.push({ key, label: dayLabel(entry.timestamp), items: [entry] });
    }
    return out;
  }, [entries, dayLabel]);

  return (
    <Page title={t("voiceless.nav.history")} fill>
      <div className="flex-1 min-h-0 flex flex-col gap-5">
        <div className="shrink-0 flex flex-wrap items-center justify-between gap-3">
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
          <div className="relative min-w-0 flex-1 max-w-[220px]">
            <Search
              size={14}
              className="absolute start-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <TextInput
              className="w-full ps-8"
              value={query}
              placeholder={t("voiceless.history.searchPlaceholder")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Only the entries scroll; the filter row above stays put. The
            negative margin lets the cards' shadows bleed past the clip edge. */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 -mx-1 px-1">
          {groups.length === 0 && !loading && (
            <p className="py-8 text-center text-[13px] text-muted">
              {search
                ? t("voiceless.history.noResults")
                : t("voiceless.history.empty")}
            </p>
          )}

          {groups.map((group) => (
            <section key={group.key}>
              <h2 className="pb-1.5 text-[12px] font-semibold text-muted">
                {group.label}
              </h2>
              <div className="bg-surface rounded-card shadow-card px-4 divide-y divide-border">
                {group.items.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    showMode={filter === "all"}
                  />
                ))}
              </div>
            </section>
          ))}

          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                disabled={loading}
                onClick={() =>
                  void load(entries[entries.length - 1]?.id ?? null)
                }
              >
                {loading
                  ? t("voiceless.common.loading")
                  : t("voiceless.common.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
};
