import React from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Cpu, Gauge, History, Mic, Settings } from "lucide-react";
import SecureInputWarning from "@/components/SecureInputWarning";
import { DictionaryPage } from "./pages/DictionaryPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HomePage } from "./pages/HomePage";
import { ModelsPage } from "./pages/ModelsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsagePage } from "./pages/UsagePage";

export type PageId =
  | "home"
  | "history"
  | "usage"
  | "models"
  | "dictionary"
  | "settings";

const NAV: { id: PageId; icon: React.ReactNode }[] = [
  { id: "home", icon: <Mic size={17} /> },
  { id: "history", icon: <History size={17} /> },
  { id: "usage", icon: <Gauge size={17} /> },
  { id: "models", icon: <Cpu size={17} /> },
  { id: "dictionary", icon: <BookOpen size={17} /> },
];

const PAGES: Record<PageId, React.FC> = {
  home: HomePage,
  history: HistoryPage,
  usage: UsagePage,
  models: ModelsPage,
  dictionary: DictionaryPage,
  settings: SettingsPage,
};

const navClass = (active: boolean) =>
  `flex items-center gap-2.5 h-9 px-3 rounded-lg text-[14px] text-start cursor-pointer transition-colors ${
    active
      ? "bg-background-ui/12 text-background-ui font-semibold"
      : "text-text/75 hover:bg-mid-gray/12"
  }`;

export const SettingsShell: React.FC<{
  page: PageId;
  onPageChange: (page: PageId) => void;
}> = ({ page, onPageChange }) => {
  const { t } = useTranslation();
  const Active = PAGES[page];

  return (
    <div className="h-screen flex select-none cursor-default bg-background text-text">
      <nav className="w-[184px] shrink-0 border-e border-mid-gray/15 bg-mid-gray/5 flex flex-col pt-8 pb-4 px-3 gap-0.5">
        <div className="px-3 pb-5 text-lg font-bold tracking-tight">
          {t("voiceless.appName")}
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onPageChange(item.id)}
            className={navClass(page === item.id)}
          >
            {item.icon}
            {t(`voiceless.nav.${item.id}`)}
          </button>
        ))}
        {/* Settings sits apart from the feature pages, pinned to the bottom. */}
        <button
          type="button"
          onClick={() => onPageChange("settings")}
          className={`mt-auto ${navClass(page === "settings")}`}
        >
          <Settings size={17} />
          {t("voiceless.nav.settings")}
        </button>
      </nav>
      <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
        <div className="w-full max-w-[680px] mx-auto px-8 pt-4">
          <SecureInputWarning />
        </div>
        <Active />
      </main>
    </div>
  );
};
