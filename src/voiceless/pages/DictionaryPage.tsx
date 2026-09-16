import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { BookOpen, ChevronDown, Plus, Search, Trash2 } from "lucide-react";
import { commands, type DictionaryEntry } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { Page, Section, TextInput } from "../ui";

interface DraftEntry {
  key: number;
  term: string;
  aliases: string;
  translation: string;
  note: string;
}

let nextKey = 1;

const Field: React.FC<
  { label: string } & React.InputHTMLAttributes<HTMLInputElement>
> = ({ label, ...inputProps }) => (
  <label className="flex flex-col gap-1 min-w-0">
    <span className="text-[11px] leading-4 text-muted">{label}</span>
    <TextInput className="w-full" {...inputProps} />
  </label>
);

const toDraft = (entry: DictionaryEntry): DraftEntry => ({
  key: nextKey++,
  term: entry.term,
  aliases: (entry.aliases ?? []).join(", "),
  translation: entry.translation ?? "",
  note: entry.note ?? "",
});

const toEntry = (draft: DraftEntry): DictionaryEntry => ({
  term: draft.term.trim(),
  aliases: draft.aliases
    .split(/[,，、]/)
    .map((a) => a.trim())
    .filter(Boolean),
  translation: draft.translation.trim() || null,
  note: draft.note.trim() || null,
});

export const DictionaryPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings, refreshSettings } = useSettings();
  const [drafts, setDrafts] = useState<DraftEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  // Keys of the rows showing their alias/translation/note fields.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggle = (key: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Load once; afterwards the local draft is the source of truth while editing,
  // so rows with an empty term are not dropped mid-typing.
  useEffect(() => {
    if (settings && drafts === null) {
      setDrafts((settings.dictionary ?? []).map(toDraft));
    }
  }, [settings, drafts]);

  const persist = (next: DraftEntry[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const entries = next.map(toEntry).filter((e) => e.term);
      void commands.updateDictionary(entries).then(() => refreshSettings());
    }, 500);
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const update = (key: number, patch: Partial<DraftEntry>) => {
    setDrafts((current) => {
      const next = (current ?? []).map((d) =>
        d.key === key ? { ...d, ...patch } : d,
      );
      persist(next);
      return next;
    });
  };

  const remove = (key: number) => {
    setDrafts((current) => {
      const next = (current ?? []).filter((d) => d.key !== key);
      persist(next);
      return next;
    });
  };

  const add = () => {
    setQuery("");
    // A brand-new row opens expanded — the whole point of adding one is to
    // fill it in.
    const key = nextKey++;
    setExpanded((current) => new Set(current).add(key));
    setDrafts((current) => [
      { key, term: "", aliases: "", translation: "", note: "" },
      ...(current ?? []),
    ]);
  };

  const runImport = async (replace: boolean) => {
    const entries = await commands.importDictionaryText(importText, replace);
    setDrafts(entries.map(toDraft));
    setExpanded(new Set());
    await refreshSettings();
    setImportOpen(false);
    setImportText("");
    toast.success(
      t("voiceless.dictionary.imported", { count: entries.length }),
    );
  };

  const exportText = async () => {
    const text = await commands.exportDictionaryText();
    await writeText(text);
    toast.success(t("voiceless.dictionary.copied"));
  };

  const showSearch = (drafts?.length ?? 0) > 6;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return drafts ?? [];
    return (drafts ?? []).filter((d) =>
      [d.term, d.aliases, d.translation, d.note].some((f) =>
        f.toLowerCase().includes(q),
      ),
    );
  }, [drafts, query]);

  return (
    <Page
      title={t("voiceless.dictionary.title")}
      description={t("voiceless.dictionary.description")}
      fill
    >
      <Section
        fill
        icon={<BookOpen size={20} />}
        title={t("voiceless.dictionary.title")}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImportOpen(!importOpen)}
            >
              {t("voiceless.dictionary.import")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void exportText()}>
              {t("voiceless.dictionary.export")}
            </Button>
            <Button variant="primary" size="sm" onClick={add}>
              <Plus size={14} />
              {t("voiceless.dictionary.add")}
            </Button>
          </>
        }
        // Omitted entirely when there is nothing to pin, so the card does not
        // grow a stray divider under its header.
        toolbar={
          !importOpen && !showSearch ? undefined : (
            <>
              {importOpen && (
                <div className="py-4 flex flex-col gap-2">
                  <div className="text-[15px] font-semibold">
                    {t("voiceless.dictionary.importTitle")}
                  </div>
                  <textarea
                    className="w-full min-w-0 min-h-32 p-3 text-sm font-mono rounded-control border border-border bg-surface focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
                    placeholder={t("voiceless.dictionary.importPlaceholder")}
                    value={importText}
                    spellCheck={false}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2 justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void runImport(true)}
                      disabled={!importText.trim()}
                    >
                      {t("voiceless.dictionary.importReplace")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => void runImport(false)}
                      disabled={!importText.trim()}
                    >
                      {t("voiceless.dictionary.importMerge")}
                    </Button>
                  </div>
                </div>
              )}

              {showSearch && (
                <div className="py-3">
                  <div className="relative">
                    <Search
                      size={15}
                      className="absolute start-3 top-1/2 -translate-y-1/2 text-muted"
                    />
                    <TextInput
                      className="w-full ps-9"
                      placeholder={t("voiceless.dictionary.search")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </>
          )
        }
      >
        {drafts !== null && drafts.length === 0 && (
          <p className="py-6 text-sm text-muted">
            {t("voiceless.dictionary.empty")}
          </p>
        )}

        {visible.map((draft) => {
          const open = expanded.has(draft.key);
          // Aliases, translation and note are empty for most entries, so a row
          // shows only its term. When one of them is filled in the chevron picks
          // up the accent colour, or a collapsed row would hide its own content.
          const hasExtras = [draft.aliases, draft.translation, draft.note].some(
            (value) => value.trim(),
          );

          return (
            <div key={draft.key} className="group">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex-1 min-w-0 flex items-center gap-2 py-2 text-start cursor-pointer"
                  aria-expanded={open}
                  title={t("voiceless.dictionary.more")}
                  onClick={() => toggle(draft.key)}
                >
                  <span className="flex-1 min-w-0 truncate text-[14px]">
                    {draft.term.trim() || (
                      <span className="text-muted italic">
                        {t("voiceless.dictionary.term")}
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    size={14}
                    className={`shrink-0 transition-transform ${
                      open ? "rotate-180" : ""
                    } ${hasExtras ? "text-accent" : "text-muted"}`}
                  />
                </button>
                {/* A sibling rather than a child: buttons cannot nest. Hidden
                    until hover so the list reads as plain words, but kept
                    visible on an open row that is being edited. */}
                <button
                  type="button"
                  className={`h-7 w-7 shrink-0 grid place-items-center rounded-control text-muted hover:text-error hover:bg-error/10 cursor-pointer transition-opacity ${
                    open
                      ? ""
                      : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  }`}
                  aria-label={t("voiceless.common.delete")}
                  title={t("voiceless.common.delete")}
                  onClick={() => remove(draft.key)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {open && (
                <div className="pb-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  <Field
                    label={t("voiceless.dictionary.term")}
                    value={draft.term}
                    autoFocus={!draft.term}
                    spellCheck={false}
                    onChange={(e) =>
                      update(draft.key, { term: e.target.value })
                    }
                  />
                  <Field
                    label={t("voiceless.dictionary.aliases")}
                    value={draft.aliases}
                    placeholder={t("voiceless.dictionary.aliasesPlaceholder")}
                    spellCheck={false}
                    onChange={(e) =>
                      update(draft.key, { aliases: e.target.value })
                    }
                  />
                  <Field
                    label={t("voiceless.dictionary.translation")}
                    value={draft.translation}
                    spellCheck={false}
                    onChange={(e) =>
                      update(draft.key, { translation: e.target.value })
                    }
                  />
                  <Field
                    label={t("voiceless.dictionary.note")}
                    value={draft.note}
                    onChange={(e) =>
                      update(draft.key, { note: e.target.value })
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </Section>
    </Page>
  );
};
