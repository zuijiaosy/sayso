import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en/translation.json";
import zh from "../../src/i18n/locales/zh/translation.json";
import { HistoryDetailsModal } from "../../src/voiceless/pages/HistoryDetailsModal";
import { useSettingsStore } from "../../src/stores/settingsStore";
import type { HistoryEntry } from "../../src/bindings";
import "../../src/App.css";

const params = new URLSearchParams(location.search);
await i18n.use(initReactI18next).init({
  lng: params.get("language") ?? "en",
  resources: { en: { translation: en }, zh: { translation: zh } },
});
useSettingsStore.setState({ isLoading: false });

const entry: HistoryEntry = {
  id: 1,
  file_name: "test.wav",
  timestamp: 100,
  saved: false,
  title: "Test",
  transcription_text: params.get("failure") === "asr" ? "" : "Hello",
  post_processed_text: null,
  post_process_prompt: null,
  post_process_requested: true,
  mode: "translate",
  audio_ms: 1000,
  asr: { provider: "local", model: null, usage: null, ms: 100 },
  llm: null,
};

function Fixture() {
  const [open, setOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open details</button>
      <button onClick={() => setDeleted(true)}>Delete background entry</button>
      <output>{deleted ? "Deleted" : "Preserved"}</output>
      <HistoryDetailsModal
        entry={entry}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
