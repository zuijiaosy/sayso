import React from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Cpu,
  Keyboard,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import SecureInputWarning from "@/components/SecureInputWarning";
import { DictionaryPage } from "./pages/DictionaryPage";
import { GeneralPage } from "./pages/GeneralPage";
import { ModelsPage } from "./pages/ModelsPage";
import { PermissionsPage } from "./pages/PermissionsPage";
import { ShortcutsPage } from "./pages/ShortcutsPage";

export type PageId =
  | "shortcuts"
  | "models"
  | "dictionary"
  | "general"
  | "permissions";

const NAV: { id: PageId; icon: React.ReactNode }[] = [
  { id: "shortcuts", icon: <Keyboard size={17} /> },
  { id: "models", icon: <Cpu size={17} /> },
  { id: "dictionary", icon: <BookOpen size={17} /> },
  { id: "general", icon: <SlidersHorizontal size={17} /> },
  { id: "permissions", icon: <Shield size={17} /> },
];

const PAGES: Record<PageId, React.FC> = {
  shortcuts: ShortcutsPage,
  models: ModelsPage,
  dictionary: DictionaryPage,
  general: GeneralPage,
  permissions: PermissionsPage,
};

export const SettingsShell: React.FC<{
  page: PageId;
  onPageChange: (page: PageId) => void;
}> = ({ page, onPageChange }) => {
  const { t } = useTranslation();
  const Active = PAGES[page];

  return (
    <div className="h-screen flex select-none cursor-default bg-background text-text">
      <nav className="w-[184px] shrink-0 border-e border-mid-gray/15 bg-mid-gray/5 flex flex-col pt-8 px-3 gap-0.5">
        <div className="px-3 pb-5 text-lg font-bold tracking-tight">
          {t("voiceless.appName")}
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onPageChange(item.id)}
            className={`flex items-center gap-2.5 h-9 px-3 rounded-lg text-[14px] text-start cursor-pointer transition-colors ${
              page === item.id
                ? "bg-background-ui/12 text-background-ui font-semibold"
                : "text-text/75 hover:bg-mid-gray/12"
            }`}
          >
            {item.icon}
            {t(`voiceless.nav.${item.id}`)}
          </button>
        ))}
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
