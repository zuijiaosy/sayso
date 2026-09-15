import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { BookOpen, Plus, Search, Trash2 } from "lucide-react";
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
    <span className="text-[11px] leading-4 text-mid-gray">{label}</span>
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setDrafts((current) => [
      { key: nextKey++, term: "", aliases: "", translation: "", note: "" },
      ...(current ?? []),
    ]);
  };

  const runImport = async (replace: boolean) => {
    const entries = await commands.importDictionaryText(importText, replace);
    setDrafts(entries.map(toDraft));
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
    >
      <Section
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
      >
        {importOpen && (
          <div className="py-4 flex flex-col gap-2">
            <div className="text-[15px] font-semibold">
              {t("voiceless.dictionary.importTitle")}
            </div>
            <textarea
              className="w-full min-w-0 min-h-32 p-3 text-sm font-mono rounded-lg border border-mid-gray/30 bg-background focus:outline-none focus:border-background-ui"
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

        {(drafts?.length ?? 0) > 6 && (
          <div className="py-3">
            <div className="relative">
              <Search
                size={15}
                className="absolute start-3 top-1/2 -translate-y-1/2 text-mid-gray"
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

        {drafts !== null && drafts.length === 0 && (
          <p className="py-6 text-sm text-mid-gray">
            {t("voiceless.dictionary.empty")}
          </p>
        )}

        {visible.map((draft) => (
          <div
            key={draft.key}
            className="py-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-end"
          >
            <Field
              label={t("voiceless.dictionary.term")}
              value={draft.term}
              autoFocus={!draft.term}
              spellCheck={false}
              onChange={(e) => update(draft.key, { term: e.target.value })}
            />
            <Field
              label={t("voiceless.dictionary.aliases")}
              value={draft.aliases}
              placeholder={t("voiceless.dictionary.aliasesPlaceholder")}
              spellCheck={false}
              onChange={(e) => update(draft.key, { aliases: e.target.value })}
            />
            <button
              type="button"
              className="h-9 w-9 grid place-items-center rounded-lg text-mid-gray hover:text-error hover:bg-error/10 cursor-pointer"
              aria-label={t("voiceless.common.delete")}
              title={t("voiceless.common.delete")}
              onClick={() => remove(draft.key)}
            >
              <Trash2 size={16} />
            </button>
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
              onChange={(e) => update(draft.key, { note: e.target.value })}
            />
          </div>
        ))}
      </Section>
    </Page>
  );
};
