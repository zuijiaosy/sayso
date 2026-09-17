import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Cpu } from "lucide-react";
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg?raw";
import apple from "@lobehub/icons-static-svg/icons/apple.svg?raw";
import bailian from "@lobehub/icons-static-svg/icons/bailian.svg?raw";
import bedrock from "@lobehub/icons-static-svg/icons/bedrock.svg?raw";
import cerebras from "@lobehub/icons-static-svg/icons/cerebras.svg?raw";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek.svg?raw";
import groq from "@lobehub/icons-static-svg/icons/groq.svg?raw";
import ollama from "@lobehub/icons-static-svg/icons/ollama.svg?raw";
import openai from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import openrouter from "@lobehub/icons-static-svg/icons/openrouter.svg?raw";
import stepfun from "@lobehub/icons-static-svg/icons/stepfun.svg?raw";
import zai from "@lobehub/icons-static-svg/icons/zai.svg?raw";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu.svg?raw";
import { useSettings } from "@/hooks/useSettings";
import { useModelStore } from "@/stores/modelStore";

/** `AsrTrace.provider` for on-device recognition (mirrors the Rust const). */
export const LOCAL_PROVIDER = "local";

export type ProviderKind = "asr" | "llm";

// The bundled files carry their own <title>, which the browser would show as
// an English tooltip on top of ours.
const stripTitle = (svg: string) => svg.replace(/<title>[\s\S]*?<\/title>/, "");

/**
 * Brand marks keyed by provider id, from @lobehub/icons (monochrome variants,
 * `fill="currentColor"`, so they follow the surrounding text colour).
 * `dashscope` is both a speech and a text vendor; both use the Bailian mark.
 */
const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries({
    deepseek,
    dashscope: bailian,
    openai,
    zai,
    openrouter,
    anthropic,
    groq,
    cerebras,
    apple_intelligence: apple,
    bedrock_mantle: bedrock,
    custom: ollama,
    glm: zhipu,
    stepfun,
  }).map(([id, svg]) => [id, stripTitle(svg)]),
);

export const ProviderIcon: React.FC<{
  id: string;
  size?: number;
  className?: string;
  title?: string;
}> = ({ id, size = 14, className = "", title }) => {
  const label = title ? { "aria-label": title, role: "img" } : {};
  if (id === LOCAL_PROVIDER) {
    return (
      <span
        {...label}
        title={title}
        className={`inline-flex shrink-0 ${className}`}
      >
        <Cpu size={size} aria-hidden />
      </span>
    );
  }
  const svg = ICONS[id];
  if (!svg) {
    return (
      <span
        {...label}
        title={title}
        className={`inline-flex shrink-0 ${className}`}
      >
        <Bot size={size} aria-hidden />
      </span>
    );
  }
  return (
    <span
      {...label}
      aria-hidden={title ? undefined : true}
      title={title}
      className={`inline-flex shrink-0 leading-none [&>svg]:w-full [&>svg]:h-full ${className}`}
      style={{ width: size, height: size, fontSize: size }}
      // Bundled, trusted SVG from the icon package.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

const ASR_VENDOR_KEYS: Record<string, string> = {
  dashscope: "voiceless.models.cloud.vendorDashscope",
  glm: "voiceless.models.cloud.vendorGlm",
  stepfun: "voiceless.models.cloud.vendorStepfun",
};

/**
 * Human-readable names for provider and model ids recorded in history.
 * Provider ids are resolved per kind because `dashscope` exists on both sides.
 */
export const useProviderNames = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const models = useModelStore((state) => state.models);

  const providerName = useCallback(
    (id: string, kind: ProviderKind) => {
      if (kind === "asr") {
        if (id === LOCAL_PROVIDER) return t("voiceless.history.local");
        const key = ASR_VENDOR_KEYS[id];
        return key ? t(key) : id;
      }
      return (
        settings?.post_process_providers?.find((p) => p.id === id)?.label ?? id
      );
    },
    [t, settings?.post_process_providers],
  );

  const modelName = useCallback(
    (providerId: string, model: string | null) => {
      if (!model) return null;
      if (providerId !== LOCAL_PROVIDER) return model;
      return models.find((m) => m.id === model)?.name ?? model;
    },
    [models],
  );

  return { providerName, modelName };
};
