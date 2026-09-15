import { listen } from "@tauri-apps/api/event";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import type {
  FailedTranslation,
  SessionMode,
  TranslateTarget,
} from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";

type OverlayState =
  | "recording"
  | "streaming"
  | "transcribing"
  | "processing"
  | "translate_failed";

const WAVE_BARS = 11;

/** Localized language name for a BCP 47 tag, e.g. en-US → 英语（美国）. */
function languageLabel(code: string, uiLanguage: string): string {
  try {
    const names = new Intl.DisplayNames([uiLanguage, "en"], {
      type: "language",
    });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.5 8.4 L6.6 11.3 L12.5 4.8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

const Chevrons = () => (
  <svg viewBox="0 0 12 16" aria-hidden="true">
    <path
      d="M3 6 L6 3 L9 6 M3 10 L6 13 L9 10"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [captureReady, setCaptureReady] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(WAVE_BARS).fill(0));
  const [mode, setMode] = useState<SessionMode>("dictate");
  const [target, setTarget] = useState("en-US");
  const [targets, setTargets] = useState<TranslateTarget[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [failure, setFailure] = useState<FailedTranslation | null>(null);
  const [busy, setBusy] = useState(false);
  const smoothedRef = useRef<number[]>(Array(16).fill(0));

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    void commands.setOverlayPickerOpen(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      commands
        .listTranslateTargets()
        .then((list) => !disposed && setTargets(list))
        .catch(() => {});
      commands
        .getVoiceSession()
        .then((session) => {
          if (disposed) return;
          setMode(session.mode);
          setTarget(session.target_language);
          setFailure(session.failure);
        })
        .catch(() => {});

      unlisteners.push(
        await listen<OverlayState>("show-overlay", async (event) => {
          const next = event.payload;
          if (next === "recording" || next === "streaming") {
            setCaptureReady(false);
            smoothedRef.current = Array(16).fill(0);
            setLevels(Array(WAVE_BARS).fill(0));
            setFailure(null);
          }
          if (next === "translate_failed") {
            // The failure event may not have arrived yet; read it directly.
            commands
              .getVoiceSession()
              .then((session) => session.failure && setFailure(session.failure))
              .catch(() => {});
          }
          setPickerOpen(false);
          setBusy(false);
          setState(next);
          setIsVisible(true);
          await syncLanguageFromSettings();
        }),
      );
      unlisteners.push(
        await listen("hide-overlay", () => {
          setIsVisible(false);
          setCaptureReady(false);
          setPickerOpen(false);
        }),
      );
      unlisteners.push(
        await listen("recording-ready", () => setCaptureReady(true)),
      );
      unlisteners.push(
        await listen<number[]>("mic-level", (event) => {
          const incoming = event.payload;
          const smoothed = smoothedRef.current.map(
            (prev, i) => prev * 0.65 + (incoming[i] || 0) * 0.35,
          );
          smoothedRef.current = smoothed;
          setLevels(smoothed.slice(0, WAVE_BARS));
        }),
      );
      unlisteners.push(
        await events.sessionModeEvent.listen((event) => {
          setMode(event.payload.mode);
          setTarget(event.payload.target_language);
        }),
      );
      unlisteners.push(
        await events.translationFailedEvent.listen((event) => {
          setFailure(event.payload.failure);
          setBusy(false);
        }),
      );
    };

    void setup();
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const uiLanguage = i18n.language || "zh-CN";
  const targetLabel = useMemo(
    () => languageLabel(target, uiLanguage),
    [target, uiLanguage],
  );

  if (!isVisible) return null;

  const recording = state === "recording" || state === "streaming";
  const working = state === "transcribing" || state === "processing";
  const workLabel =
    state === "transcribing"
      ? t("overlay.transcribing")
      : mode === "translate"
        ? t("overlay.translating")
        : t("overlay.processing");

  if (state === "translate_failed" && failure) {
    const reasonKey = `overlay.reason.${failure.reason}`;
    return (
      <div className="vl-stage">
        <div className="vl-failure" role="alert">
          <div className="vl-failure-head">
            <span className="vl-failure-title">
              {t("overlay.translateFailed")}
            </span>
            <span className="vl-failure-reason">{t(reasonKey)}</span>
            <button
              className="vl-icon-btn vl-dim"
              aria-label={t("overlay.dismiss")}
              onClick={() => void commands.dismissTranslationFailure()}
            >
              <CloseIcon />
            </button>
          </div>
          <p className="vl-failure-source">{failure.source_text}</p>
          <div className="vl-failure-actions">
            <button
              className="vl-text-btn"
              onClick={() => void commands.copyFailedTranslationSource()}
            >
              {t("overlay.copySource")}
            </button>
            <button
              className="vl-text-btn vl-primary"
              disabled={busy || failure.reason === "no_text_model"}
              onClick={() => {
                setBusy(true);
                void commands.retryFailedTranslation();
              }}
            >
              {t("overlay.retry")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="vl-stage">
      {mode === "translate" && (
        <div className="vl-translate">
          {pickerOpen && (
            <ul className="vl-picker" role="listbox">
              {targets.map((item) => (
                <li key={item.code}>
                  <button
                    role="option"
                    aria-selected={item.code === target}
                    className={item.code === target ? "selected" : ""}
                    onClick={() => {
                      setTarget(item.code);
                      closePicker();
                      void commands.setSessionTranslateTarget(item.code);
                    }}
                  >
                    {languageLabel(item.code, uiLanguage)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="vl-translate-row">
            <span className="vl-translate-label">
              {t("overlay.translateTo")}
            </span>
            <button
              className="vl-select"
              disabled={!recording}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              onClick={() => {
                const next = !pickerOpen;
                setPickerOpen(next);
                void commands.setOverlayPickerOpen(next);
              }}
            >
              <span>{targetLabel}</span>
              <Chevrons />
            </button>
          </div>
        </div>
      )}

      <div className={`vl-capsule ${working ? "working" : ""}`}>
        <button
          className="vl-icon-btn vl-cancel"
          aria-label={t("overlay.cancel")}
          onClick={() => void commands.cancelOperation()}
        >
          <CloseIcon />
        </button>

        {recording ? (
          <div
            className={`vl-wave ${captureReady ? "ready" : "arming"}`}
            aria-hidden="true"
          >
            {levels.map((v, i) => {
              // Taller in the middle, like a voice memo waveform.
              const center = 1 - Math.abs(i - (WAVE_BARS - 1) / 2) / WAVE_BARS;
              const h = 4 + Math.pow(v, 0.7) * 18 * (0.55 + center * 0.45);
              return (
                <i
                  key={i}
                  style={{ height: `${Math.max(4, Math.min(22, h))}px` }}
                />
              );
            })}
          </div>
        ) : (
          <div className="vl-work">
            <span className="vl-spinner" />
            <span className="vl-work-label">{workLabel}</span>
          </div>
        )}

        <button
          className="vl-icon-btn vl-confirm"
          aria-label={t("overlay.confirm")}
          disabled={!recording}
          onClick={() => {
            closePicker();
            void commands.stopActiveRecording();
          }}
        >
          <CheckIcon />
        </button>
      </div>
    </div>
  );
};

export default RecordingOverlay;
