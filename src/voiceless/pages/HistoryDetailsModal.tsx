import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { HistoryEntry, TokenUsage } from "@/bindings";
import { Modal } from "../Modal";
import {
  LOCAL_PROVIDER,
  ProviderIcon,
  useProviderNames,
  type ProviderKind,
} from "../ProviderIcon";
import { Chip } from "../ui";

interface Route {
  provider: string;
  model: string | null;
  usage: TokenUsage | null;
  ms: number | null;
}

const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-start justify-between gap-4 py-2">
    <span className="shrink-0 text-[13px] text-muted">{label}</span>
    <span className="min-w-0 text-[13px] text-end tabular-nums break-words">
      {children}
    </span>
  </div>
);

const Block: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="pt-4">
    <h3 className="pb-1 text-[12px] font-semibold text-muted">{title}</h3>
    <div className="divide-y divide-border">{children}</div>
  </section>
);

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="py-2 text-[13px] text-muted leading-relaxed">{children}</p>
);

const RouteRows: React.FC<{ route: Route; kind: ProviderKind }> = ({
  route,
  kind,
}) => {
  const { t, i18n } = useTranslation();
  const { providerName, modelName } = useProviderNames();
  const numbers = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );
  const isLocal = kind === "asr" && route.provider === LOCAL_PROVIDER;
  const model = modelName(route.provider, route.model);

  const latency =
    route.ms === null
      ? null
      : route.ms < 1000
        ? t("voiceless.history.latencyMs", { ms: numbers.format(route.ms) })
        : t("voiceless.history.latencySeconds", {
            seconds: (route.ms / 1000).toFixed(2),
          });

  return (
    <>
      <DetailRow label={t("voiceless.history.provider")}>
        <span className="inline-flex items-center gap-1.5">
          <ProviderIcon id={route.provider} size={14} />
          {providerName(route.provider, kind)}
        </span>
      </DetailRow>
      {kind === "asr" && (
        <DetailRow label={t("voiceless.history.route")}>
          <Chip tone={isLocal ? "neutral" : "accent"}>
            {isLocal
              ? t("voiceless.history.local")
              : t("voiceless.history.cloud")}
          </Chip>
        </DetailRow>
      )}
      <DetailRow label={t("voiceless.history.model")}>
        {model ?? t("voiceless.common.notSet")}
      </DetailRow>
      {/* On-device recognition has no token bill to show. */}
      {!isLocal &&
        (route.usage ? (
          <>
            <DetailRow label={t("voiceless.history.inputTokens")}>
              {numbers.format(route.usage.input)}
            </DetailRow>
            <DetailRow label={t("voiceless.history.outputTokens")}>
              {numbers.format(route.usage.output)}
            </DetailRow>
          </>
        ) : (
          <DetailRow label={t("voiceless.history.tokens")}>
            <span className="text-muted">
              {t("voiceless.history.tokensNotReported")}
            </span>
          </DetailRow>
        ))}
      {latency && (
        <DetailRow label={t("voiceless.history.latency")}>{latency}</DetailRow>
      )}
    </>
  );
};

export const HistoryDetailsModal: React.FC<{
  entry: HistoryEntry;
  open: boolean;
  onClose: () => void;
}> = ({ entry, open, onClose }) => {
  const { t, i18n } = useTranslation();
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "medium",
      }),
    [i18n.language],
  );

  const inserted = entry.post_processed_text;
  const showInserted =
    inserted !== null && inserted !== entry.transcription_text;

  return (
    <Modal open={open} onClose={onClose} title={t("voiceless.history.details")}>
      <Block title={t("voiceless.history.recognition")}>
        {entry.asr ? (
          <RouteRows route={entry.asr} kind="asr" />
        ) : (
          <Muted>{t("voiceless.history.unknown")}</Muted>
        )}
      </Block>

      <Block title={t("voiceless.history.textModel")}>
        {entry.llm ? (
          <RouteRows route={entry.llm} kind="llm" />
        ) : (
          <Muted>
            {entry.asr
              ? t("voiceless.history.noTextModelResult")
              : t("voiceless.history.unknown")}
          </Muted>
        )}
      </Block>

      <Block title={t("voiceless.history.content")}>
        <DetailRow label={t("voiceless.history.time")}>
          {dateFormat.format(new Date(entry.timestamp * 1000))}
        </DetailRow>
        <DetailRow label={t("voiceless.history.duration")}>
          {t("voiceless.history.latencySeconds", {
            seconds: (entry.audio_ms / 1000).toFixed(1),
          })}
        </DetailRow>
        <div className="py-2">
          <div className="text-[13px] text-muted">
            {t("voiceless.history.rawTranscript")}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
            {entry.transcription_text.trim() ||
              t("voiceless.history.emptyText")}
          </p>
        </div>
        {showInserted && (
          <div className="py-2">
            <div className="text-[13px] text-muted">
              {t("voiceless.history.finalText")}
            </div>
            <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-wrap break-words">
              {inserted}
            </p>
          </div>
        )}
      </Block>
    </Modal>
  );
};
