import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  AudioLines,
  Cloud,
  FolderOpen,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  commands,
  type AsrProviderKind,
  type CloudAsrProvider,
  type DashScopeAsrSettings,
  type GlmAsrSettings,
  type DictationPostMode,
  type ModelInfo,
} from "@/bindings";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/hooks/useSettings";
import { useModelStore } from "@/stores/modelStore";
import {
  Notice,
  Page,
  Row,
  Section,
  Segmented,
  SelectInput,
  StatusPill,
  Switch,
  TextInput,
} from "../ui";

export const SENSE_VOICE_ID = "sense-voice-int8";

const isUrlSource = (m: ModelInfo) =>
  typeof m.source === "object" && "Url" in m.source;
const supportsChinese = (m: ModelInfo) =>
  m.supported_languages.some((l) => l === "zh" || l.startsWith("zh"));

/** Chinese-capable local models, SenseVoice first, then downloaded ones. */
export const useChineseModels = () => {
  const { models } = useModelStore();
  return useMemo(() => {
    const list = models.filter(
      (m) =>
        supportsChinese(m) &&
        (!isUrlSource(m) || m.id === SENSE_VOICE_ID || m.is_downloaded),
    );
    const rank = (m: ModelInfo) =>
      m.id === SENSE_VOICE_ID ? 0 : m.is_downloaded ? 1 : 2;
    return [...list].sort((a, b) => rank(a) - rank(b));
  }, [models]);
};

export const importSenseVoiceFolder = async (
  t: (key: string, opts?: Record<string, unknown>) => string,
): Promise<boolean> => {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return false;
  const result = await commands.importSenseVoiceModel(selected);
  if (result.status === "error") {
    toast.error(
      t("voiceless.models.local.importFailed", { error: result.error }),
    );
    return false;
  }
  toast.success(t("voiceless.models.local.importOk"));
  await useModelStore.getState().loadModels();
  await useModelStore.getState().loadCurrentModel();
  return true;
};

const ModelRow: React.FC<{ model: ModelInfo }> = ({ model }) => {
  const { t } = useTranslation();
  const {
    currentModel,
    downloadingModels,
    downloadProgress,
    verifyingModels,
    extractingModels,
    downloadModel,
    cancelDownload,
    selectModel,
    deleteModel,
  } = useModelStore();
  const [busy, setBusy] = useState(false);

  const downloading = model.id in downloadingModels;
  const verifying = model.id in verifyingModels;
  const extracting = model.id in extractingModels;
  const percent = Math.round(downloadProgress[model.id]?.percentage ?? 0);
  const inUse = currentModel === model.id;

  let status: React.ReactNode;
  if (downloading) {
    status = (
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-mid-gray tabular-nums">
          {t("voiceless.models.local.downloading", { percent })}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void cancelDownload(model.id)}
        >
          {t("voiceless.models.local.cancel")}
        </Button>
      </div>
    );
  } else if (verifying || extracting) {
    status = (
      <span className="text-[13px] text-mid-gray">
        {t(
          verifying
            ? "voiceless.models.local.verifying"
            : "voiceless.models.local.extracting",
        )}
      </span>
    );
  } else if (!model.is_downloaded) {
    status = (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void downloadModel(model.id)}
      >
        {t("voiceless.models.local.download")}
      </Button>
    );
  } else if (inUse) {
    status = <StatusPill ok>{t("voiceless.models.local.inUse")}</StatusPill>;
  } else {
    status = (
      <div className="flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await selectModel(model.id);
            setBusy(false);
          }}
        >
          {t("voiceless.models.local.use")}
        </Button>
        {!model.is_custom && (
          <Button
            variant="danger-ghost"
            size="sm"
            onClick={() => void deleteModel(model.id)}
          >
            {t("voiceless.models.local.delete")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          {model.name}
          {model.id === SENSE_VOICE_ID && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-background-ui/15 text-background-ui">
              {t("voiceless.models.local.recommended")}
            </span>
          )}
        </span>
      }
      description={
        <>
          {t("voiceless.models.local.size", { size: model.size_mb })}
          {" · "}
          {model.supported_languages.slice(0, 6).join(", ")}
          {model.supported_languages.length > 6 ? "…" : ""}
        </>
      }
    >
      {status}
    </Row>
  );
};

const LocalModels: React.FC = () => {
  const { t } = useTranslation();
  const models = useChineseModels();
  const { rescanLocalModels, isRescanning } = useModelStore();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? models : models.slice(0, 5);

  return (
    <>
      {visible.length === 0 && (
        <Row title={t("voiceless.models.local.empty")} />
      )}
      {visible.map((model) => (
        <ModelRow key={model.id} model={model} />
      ))}
      <div className="py-3 flex flex-wrap items-center gap-2">
        {models.length > 5 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "−" : `+${models.length - 5}`}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="inline-flex items-center gap-1.5"
          onClick={() => void importSenseVoiceFolder(t)}
        >
          <FolderOpen size={14} />
          {t("voiceless.models.local.import")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={isRescanning}
          onClick={() => void rescanLocalModels()}
          aria-label="rescan"
        >
          <RefreshCw size={14} className={isRescanning ? "animate-spin" : ""} />
        </Button>
      </div>
      <p className="text-xs text-mid-gray pb-2">
        {t("voiceless.models.local.importDesc")}
      </p>
    </>
  );
};

const LANGUAGE_CODES = [
  "auto",
  "zh",
  "en",
  "yue",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "ru",
  "pt",
  "it",
  "ar",
  "vi",
  "th",
  "id",
];

/** API key field saved on blur to `asr_api_keys[vendor]`. */
const CloudApiKeyRow: React.FC<{
  vendor: "dashscope" | "glm";
  description: string;
}> = ({ vendor, description }) => {
  const { t } = useTranslation();
  const { settings, refreshSettings } = useSettings();
  const stored = settings?.asr_api_keys?.[vendor] ?? "";
  const [apiKey, setApiKey] = useState(stored);
  useEffect(() => setApiKey(stored), [stored]);

  return (
    <Row
      title={t("voiceless.models.cloud.apiKey")}
      description={description}
      stacked
    >
      <TextInput
        className="w-full"
        type="password"
        autoComplete="off"
        value={apiKey}
        placeholder="sk-…"
        onChange={(e) => setApiKey(e.target.value)}
        onBlur={async () => {
          if (apiKey === stored) return;
          const result = await commands.setAsrApiKey(vendor, apiKey);
          if (result.status === "error") toast.error(result.error);
          await refreshSettings();
        }}
      />
    </Row>
  );
};

const DashscopeForm: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const stored = settings?.dashscope_asr;
  const [draft, setDraft] = useState<DashScopeAsrSettings | null>(null);

  useEffect(() => {
    if (stored && !draft) setDraft(stored);
  }, [stored, draft]);

  if (!draft) return null;

  const languageName = (code: string) => {
    if (code === "auto") return t("voiceless.models.cloud.languageAuto");
    try {
      return (
        new Intl.DisplayNames([i18n.language, "en"], { type: "language" }).of(
          code,
        ) ?? code
      );
    } catch {
      return code;
    }
  };

  const save = async (next: DashScopeAsrSettings) => {
    setDraft(next);
    await updateSetting("dashscope_asr", next);
  };

  return (
    <>
      <Row
        title={t("voiceless.models.cloud.endpoint")}
        description={t("voiceless.models.cloud.endpointDesc")}
        stacked
      >
        <TextInput
          className="w-full"
          value={draft.endpoint}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
          onBlur={() => void save(draft)}
        />
      </Row>
      <CloudApiKeyRow
        vendor="dashscope"
        description={t("voiceless.models.cloud.apiKeyDesc")}
      />
      <Row title={t("voiceless.models.cloud.model")}>
        <TextInput
          className="w-56"
          value={draft.model}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          onBlur={() => void save(draft)}
        />
      </Row>
      <Row title={t("voiceless.models.cloud.language")}>
        <SelectInput
          value={draft.language}
          onChange={(e) => void save({ ...draft, language: e.target.value })}
        >
          {LANGUAGE_CODES.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </SelectInput>
      </Row>
      <Row
        title={t("voiceless.models.cloud.sendDictionary")}
        description={t("voiceless.models.cloud.sendDictionaryDesc")}
      >
        <Switch
          checked={draft.send_dictionary}
          onChange={(checked) =>
            void save({ ...draft, send_dictionary: checked })
          }
        />
      </Row>
    </>
  );
};

const GlmForm: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const stored = settings?.glm_asr;
  const [draft, setDraft] = useState<GlmAsrSettings | null>(null);

  useEffect(() => {
    if (stored && !draft) setDraft(stored);
  }, [stored, draft]);

  if (!draft) return null;

  const save = async (next: GlmAsrSettings) => {
    setDraft(next);
    await updateSetting("glm_asr", next);
  };

  return (
    <>
      <Row
        title={t("voiceless.models.cloud.endpoint")}
        description={t("voiceless.models.glm.endpointDesc")}
        stacked
      >
        <TextInput
          className="w-full"
          value={draft.endpoint}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
          onBlur={() => void save(draft)}
        />
      </Row>
      <CloudApiKeyRow
        vendor="glm"
        description={t("voiceless.models.glm.apiKeyDesc")}
      />
      <Row title={t("voiceless.models.cloud.model")}>
        <TextInput
          className="w-56"
          value={draft.model}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          onBlur={() => void save(draft)}
        />
      </Row>
      <Row
        title={t("voiceless.models.glm.sendDictionary")}
        description={t("voiceless.models.glm.sendDictionaryDesc")}
      >
        <Switch
          checked={draft.send_dictionary}
          onChange={(checked) =>
            void save({ ...draft, send_dictionary: checked })
          }
        />
      </Row>
    </>
  );
};

const CloudAsrSection: React.FC = () => {
  const { t } = useTranslation();
  const { settings, refreshSettings } = useSettings();
  const vendor: CloudAsrProvider = settings?.cloud_asr_provider ?? "dashscope";
  const [testing, setTesting] = useState(false);

  const test = async () => {
    // Let pending blur saves land first.
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise((r) => setTimeout(r, 150));
    setTesting(true);
    const result = await commands.testCloudAsr();
    setTesting(false);
    if (result.status === "ok") {
      toast.success(t("voiceless.models.cloud.testOk", { ms: result.data }));
    } else {
      toast.error(
        t("voiceless.models.cloud.testFailed", { error: result.error }),
      );
    }
  };

  return (
    <Section
      icon={<Cloud size={20} />}
      title={t("voiceless.models.cloud.title")}
    >
      <Row title={t("voiceless.models.cloud.vendor")}>
        <SelectInput
          value={vendor}
          onChange={async (e) => {
            await commands.updateCloudAsrProvider(
              e.target.value as CloudAsrProvider,
            );
            await refreshSettings();
          }}
        >
          <option value="dashscope">
            {t("voiceless.models.cloud.vendorDashscope")}
          </option>
          <option value="glm">{t("voiceless.models.cloud.vendorGlm")}</option>
        </SelectInput>
      </Row>
      {vendor === "glm" ? (
        <GlmForm key="glm" />
      ) : (
        <DashscopeForm key="dashscope" />
      )}
      <div className="py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={testing}
          onClick={() => void test()}
        >
          {testing ? t("voiceless.common.testing") : t("voiceless.common.test")}
        </Button>
      </div>
    </Section>
  );
};

const TextModelSection: React.FC = () => {
  const { t } = useTranslation();
  const {
    settings,
    updateSetting,
    setPostProcessProvider,
    updatePostProcessBaseUrl,
    updatePostProcessApiKey,
    updatePostProcessModel,
    fetchPostProcessModels,
    postProcessModelOptions,
  } = useSettings();
  const providerId = settings?.post_process_provider_id ?? "deepseek";
  const provider = settings?.post_process_providers?.find(
    (p) => p.id === providerId,
  );
  const storedKey = settings?.post_process_api_keys?.[providerId] ?? "";
  const storedModel = settings?.post_process_models?.[providerId] ?? "";
  const [apiKey, setApiKey] = useState(storedKey);
  const [model, setModel] = useState(storedModel);
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [testing, setTesting] = useState(false);

  useEffect(() => setApiKey(storedKey), [storedKey, providerId]);
  useEffect(() => setModel(storedModel), [storedModel, providerId]);
  useEffect(
    () => setBaseUrl(provider?.base_url ?? ""),
    [provider?.base_url, providerId],
  );

  const isApple = providerId === "apple_intelligence";
  const configured =
    Boolean(storedModel.trim()) &&
    (isApple || providerId === "custom" || Boolean(storedKey.trim()));
  const mode = settings?.dictation_post_mode ?? "polish";
  const modelOptions = postProcessModelOptions[providerId] ?? [];

  const test = async () => {
    setTesting(true);
    const result = await commands.testTextModel();
    setTesting(false);
    if (result.status === "ok")
      toast.success(t("voiceless.models.text.testOk"));
    else
      toast.error(
        t("voiceless.models.text.testFailed", { error: result.error }),
      );
  };

  return (
    <Section
      icon={<Sparkles size={20} />}
      title={t("voiceless.models.text.title")}
      description={t("voiceless.models.text.description")}
    >
      {!configured && (
        <div className="pt-4">
          <Notice tone="info">
            {t("voiceless.models.text.notConfigured")}
          </Notice>
        </div>
      )}
      <Row title={t("voiceless.models.text.provider")}>
        <SelectInput
          value={providerId}
          onChange={(e) => void setPostProcessProvider(e.target.value)}
        >
          {settings?.post_process_providers?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </SelectInput>
      </Row>
      {!isApple && (
        <>
          <Row title={t("voiceless.models.text.baseUrl")} stacked>
            <TextInput
              className="w-full"
              value={baseUrl}
              spellCheck={false}
              disabled={!provider?.allow_base_url_edit}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => {
                if (baseUrl !== provider?.base_url)
                  void updatePostProcessBaseUrl(providerId, baseUrl);
              }}
            />
          </Row>
          <Row title={t("voiceless.models.text.apiKey")} stacked>
            <TextInput
              className="w-full"
              type="password"
              autoComplete="off"
              placeholder="sk-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={() => {
                if (apiKey !== storedKey)
                  void updatePostProcessApiKey(providerId, apiKey);
              }}
            />
          </Row>
        </>
      )}
      <Row title={t("voiceless.models.text.model")}>
        <div className="flex items-center gap-2">
          <TextInput
            className="w-56"
            list={`models-${providerId}`}
            value={model}
            spellCheck={false}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => {
              if (model !== storedModel)
                void updatePostProcessModel(providerId, model);
            }}
          />
          <datalist id={`models-${providerId}`}>
            {modelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {!isApple && (
            <Button
              variant="ghost"
              size="sm"
              title={t("voiceless.models.text.fetchModels")}
              aria-label={t("voiceless.models.text.fetchModels")}
              onClick={() => void fetchPostProcessModels(providerId)}
            >
              <RefreshCw size={14} />
            </Button>
          )}
        </div>
      </Row>
      <div className="py-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={testing}
          onClick={() => void test()}
        >
          {testing ? t("voiceless.common.testing") : t("voiceless.common.test")}
        </Button>
      </div>
      <Row
        title={t("voiceless.models.text.mode.title")}
        description={t(`voiceless.models.text.mode.${mode}Desc`)}
        stacked
      >
        <Segmented<DictationPostMode>
          value={mode}
          onChange={(value) => void updateSetting("dictation_post_mode", value)}
          options={[
            { value: "off", label: t("voiceless.models.text.mode.off") },
            { value: "fix", label: t("voiceless.models.text.mode.fix") },
            { value: "polish", label: t("voiceless.models.text.mode.polish") },
          ]}
        />
      </Row>
    </Section>
  );
};

export const ModelsPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings, refreshSettings } = useSettings();
  const initializeModels = useModelStore((s) => s.initialize);
  useEffect(() => {
    void initializeModels();
  }, [initializeModels]);

  const provider: AsrProviderKind = settings?.asr_provider ?? "local";

  const switchProvider = async (value: AsrProviderKind) => {
    try {
      await commands.updateAsrProvider(value);
    } catch (error) {
      toast.error(String(error));
    }
    await refreshSettings();
  };

  return (
    <Page title={t("voiceless.models.title")}>
      <Section
        icon={<AudioLines size={20} />}
        title={t("voiceless.models.asr.title")}
        description={t("voiceless.models.asr.description")}
      >
        <Row
          title={
            provider === "local"
              ? t("voiceless.models.asr.local")
              : t("voiceless.models.asr.cloud")
          }
          description={
            provider === "local"
              ? t("voiceless.models.asr.localDesc")
              : t("voiceless.models.asr.cloudDesc")
          }
        >
          <Segmented<AsrProviderKind>
            value={provider}
            onChange={(value) => void switchProvider(value)}
            options={[
              { value: "local", label: t("voiceless.models.asr.local") },
              { value: "cloud", label: t("voiceless.models.asr.cloud") },
            ]}
          />
        </Row>
        {provider === "local" ? <LocalModels /> : null}
      </Section>
      {provider === "cloud" && <CloudAsrSection />}
      <TextModelSection />
    </Page>
  );
};
