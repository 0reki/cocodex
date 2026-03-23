#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type LocaleCode =
  | "zh-CN"
  | "zh-HK"
  | "zh-MO"
  | "zh-TW"
  | "ja-JP"
  | "es-ES"
  | "fr-FR"
  | "de-DE"
  | "ko-KR"
  | "pt-BR"
  | "it-IT"
  | "ru-RU"
  | "tr-TR";

type CliOptions = {
  locales: LocaleCode[];
  all: boolean;
  mode: "smart" | "missing";
  batchSize: number;
  model: string;
  help: boolean;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const LOCALES_DIR = resolve(ROOT, "locales");
const EN_FILE = resolve(LOCALES_DIR, "en-US.ts");

const SUPPORTED_LOCALES: LocaleCode[] = [
  "zh-CN",
  "zh-HK",
  "zh-MO",
  "zh-TW",
  "ja-JP",
  "es-ES",
  "fr-FR",
  "de-DE",
  "ko-KR",
  "pt-BR",
  "it-IT",
  "ru-RU",
  "tr-TR",
];

const NO_TRANSLATE_TERMS = [
  "OpenAI",
  "API",
  "API Key",
  "Linux.do",
  "Linux DO",
  "RPM",
  "TPM",
  "TTFB",
  "JSON",
  "Token",
  "Tokens",
  "CoCodex",
  "USD",
  "ID",
  "Key",
];

function localeConstName(locale: string) {
  const [lang, region] = locale.split("-");
  if (!lang || !region) return locale.replace(/-/g, "");
  return `${lang}${region}`;
}

function escapeTsString(input: string) {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripCodeFences(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    const withoutStart = lines.slice(1);
    const endIdx = withoutStart.findIndex((line) => line.trim().startsWith("```"));
    if (endIdx >= 0) return withoutStart.slice(0, endIdx).join("\n");
    return withoutStart.join("\n");
  }
  return trimmed;
}

function parseLocaleMapFromTs(source: string): Map<string, string> {
  const objectMatch = source.match(/export const\s+\w+\s*=\s*\{([\s\S]*?)\}\s*as const;/);
  if (!objectMatch) {
    throw new Error("Failed to parse locale file: object literal not found");
  }
  const body = objectMatch[1] ?? "";
  const map = new Map<string, string>();
  const lineRegex = /^\s*"((?:\\.|[^"\\])+)":\s*"((?:\\.|[^"\\])*)",?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(body)) !== null) {
    const rawKey = m[1] ?? "";
    const rawValue = m[2] ?? "";
    const key = rawKey.replace(/\\"/g, '"');
    const value = rawValue.replace(/\\"/g, '"');
    map.set(key, value);
  }
  return map;
}

function readLocaleMap(filePath: string): Map<string, string> {
  return parseLocaleMapFromTs(readFileSync(filePath, "utf8"));
}

function writeLocaleFile(locale: LocaleCode, values: Map<string, string>, orderedKeys: string[]) {
  const constName = localeConstName(locale);
  const lines: string[] = [];
  lines.push('import { enUS } from "./en-US";');
  lines.push("");
  lines.push(`export const ${constName} = {`);
  lines.push("  ...enUS,");
  for (const key of orderedKeys) {
    const value = values.get(key) ?? "";
    lines.push(`  "${escapeTsString(key)}": "${escapeTsString(value)}",`);
  }
  lines.push("} as const;");
  lines.push("");
  writeFileSync(resolve(LOCALES_DIR, `${locale}.ts`), lines.join("\n"));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function translateBatch(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  locale: LocaleCode;
  input: Array<{ key: string; value: string }>;
}) {
  const { baseUrl, apiKey, model, locale, input } = params;
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a professional software localization translator. Return strict JSON only.",
        },
        {
          role: "user",
          content: [
            `Translate the following i18n values from English to locale "${locale}".`,
            "Requirements:",
            "- Keep all keys unchanged.",
            "- Keep placeholders unchanged: {count}, {time}, {success}, etc.",
            "- Keep punctuation and symbols where reasonable.",
            "- Keep these terms untranslated when they appear:",
            NO_TRANSLATE_TERMS.join(", "),
            "- Return JSON object only: {\"key\":\"translated text\"}.",
            "",
            JSON.stringify(
              Object.fromEntries(input.map((item) => [item.key, item.value])),
              null,
              2,
            ),
          ].join("\n"),
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Translate request failed: HTTP ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Translate response missing content");
  const raw = stripCodeFences(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse translation JSON: ${raw.slice(0, 500)}`);
  }
  const out = new Map<string, string>();
  for (const { key } of input) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim().length > 0) {
      out.set(key, value);
    }
  }
  return out;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    locales: [],
    all: false,
    mode: "smart",
    batchSize: 80,
    model: process.env.TRANSLATE_MODEL?.trim() || "gpt-4.1-mini",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--all") {
      opts.all = true;
      continue;
    }
    if (arg === "--missing-only") {
      opts.mode = "missing";
      continue;
    }
    if (arg === "--mode") {
      const value = (argv[i + 1] ?? "").trim().toLowerCase();
      i += 1;
      if (value === "missing" || value === "smart") {
        opts.mode = value;
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--locales" || arg === "-l") {
      const value = argv[i + 1] ?? "";
      i += 1;
      opts.locales = value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .filter((v): v is LocaleCode => SUPPORTED_LOCALES.includes(v as LocaleCode));
      continue;
    }
    if (arg === "--batch-size") {
      const value = Number(argv[i + 1] ?? "");
      i += 1;
      if (Number.isFinite(value) && value > 0) opts.batchSize = Math.trunc(value);
      continue;
    }
    if (arg === "--model") {
      const value = argv[i + 1] ?? "";
      i += 1;
      if (value.trim()) opts.model = value.trim();
      continue;
    }
  }
  if (opts.locales.length === 0) {
    opts.locales = [...SUPPORTED_LOCALES];
  }
  return opts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        "Usage: bun run scripts/translate-locales.ts [options]",
        "",
        "Env:",
        "  TRANSLATE_BASE_URL   required, e.g. https://api.openai.com",
        "  TRANSLATE_API_KEY    required",
        "  TRANSLATE_MODEL      optional, default gpt-4.1-mini",
        "",
        "Options:",
        "  -l, --locales a,b,c  target locales, default all supported",
        "  --all                retranslate all keys",
        "  --missing-only       only translate missing keys",
        "  --mode MODE          smart|missing (default: smart)",
        "                       smart: translate missing + english-equal keys",
        "                       missing: translate missing keys only",
        "  --batch-size N       keys per request, default 80",
        "  --model MODEL        override model for this run",
        "  -h, --help           show this help",
      ].join("\n"),
    );
    return;
  }
  const baseUrl = process.env.TRANSLATE_BASE_URL?.trim();
  const apiKey = process.env.TRANSLATE_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error("Missing TRANSLATE_BASE_URL or TRANSLATE_API_KEY");
  }

  const enMap = readLocaleMap(EN_FILE);
  const enKeys = [...enMap.keys()];

  for (const locale of options.locales) {
    const filePath = resolve(LOCALES_DIR, `${locale}.ts`);
    const currentMap = readLocaleMap(filePath);
    const pendingKeys = enKeys.filter((key) => {
      if (options.all) return true;
      const current = currentMap.get(key);
      const source = enMap.get(key) ?? "";
      if (options.mode === "missing") {
        return !current;
      }
      return !current || current === source;
    });

    if (pendingKeys.length === 0) {
      console.log(`[${locale}] up-to-date`);
      continue;
    }

    console.log(`[${locale}] translating ${pendingKeys.length} keys...`);
    const chunks = chunkArray(pendingKeys, options.batchSize);
    for (let idx = 0; idx < chunks.length; idx += 1) {
      const chunk = chunks[idx] ?? [];
      const input = chunk.map((key) => ({ key, value: enMap.get(key) ?? "" }));
      console.log(`[${locale}] batch ${idx + 1}/${chunks.length} (${chunk.length} keys)`);
      const translated = await translateBatch({
        baseUrl,
        apiKey,
        model: options.model,
        locale,
        input,
      });
      for (const [key, value] of translated.entries()) {
        currentMap.set(key, value);
      }
    }

    for (const key of enKeys) {
      if (!currentMap.has(key)) currentMap.set(key, enMap.get(key) ?? "");
    }
    writeLocaleFile(locale, currentMap, enKeys);
    console.log(`[${locale}] done`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
