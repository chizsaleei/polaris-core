// src/lib/openai.ts
/**
 * Polaris Core — OpenAI helper
 * Minimal, dependency-free wrapper around OpenAI HTTP endpoints with
 * retries, timeouts, and safe logging. Works in Node 18+ (undici fetch).
 *
 * Endpoints covered:
 *  - Chat Completions (JSON or text)
 *  - Embeddings
 *  - Moderations
 *  - Audio Transcriptions (STT)
 *  - Audio Speech (TTS)
 */

import { log, safeError } from "./logger";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

if (!OPENAI_API_KEY) {
  log.warn("OPENAI_API_KEY is not set. OpenAI calls will fail.");
}

// -------- Types -------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatOptions {
  model?: string; // defaults to OPENAI_CHAT_MODEL env
  messages: ChatMessage[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean; // sets response_format to json_object
  extra?: Record<string, unknown>; // advanced params passthrough
  timeoutMs?: number;
}

export interface ChatResult {
  text?: string;
  json?: unknown;
  finish_reason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  raw: ChatCompletionResponse;
}

// Minimal OpenAI response shapes we rely on
interface ChatCompletionMessage {
  content?: string | ChatContentPart[] | null;
}

type ChatContentPart =
  | string
  | {
      type?: string;
      text?: string;
      // Allow future fields without `any`
      [key: string]: unknown;
    };

interface ChatCompletionChoice {
  message?: ChatCompletionMessage | null;
  finish_reason?: string;
  [key: string]: unknown;
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  [key: string]: unknown;
}

interface ChatPayload {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
  // Allow extra tuning fields (top_p, presence_penalty, etc.)
  [key: string]: unknown;
}

export interface EmbeddingOptions {
  model?: string; // defaults to OPENAI_EMBED_MODEL env
  input: string | string[];
  timeoutMs?: number;
}

export interface ModerationOptions {
  model?: string; // default omni-moderation-latest
  input: string | string[];
  timeoutMs?: number;
}

export interface TranscribeOptions {
  model?: string; // default whisper-1
  file: Blob | ArrayBuffer | Uint8Array; // provide binary audio
  filename?: string; // hint for multipart
  language?: string; // e.g. 'en'
  temperature?: number;
  timeoutMs?: number;
}

export type TtsFormat = "mp3" | "wav" | "flac" | "opus";

export interface TtsOptions {
  model?: string; // defaults to OPENAI_TTS_MODEL env
  input: string;
  voice?: string; // e.g. 'alloy'
  format?: TtsFormat;
  speed?: number; // 0.25..4
  timeoutMs?: number;
}

// -------- Core HTTP helpers ------------------------------------------

async function httpJson<T>(path: string, body: unknown, timeoutMs = 30000): Promise<T> {
  const url = `${OPENAI_BASE_URL}${path}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text || null;
    }
    if (!res.ok) {
      log.error("openai http error", { path, status: res.status, body: parsed });
      throw new Error(`OpenAI error ${res.status}`);
    }
    return parsed as T;
  } finally {
    clearTimeout(id);
  }
}

async function httpMultipart<T>(path: string, form: FormData, timeoutMs = 60000): Promise<T> {
  const url = `${OPENAI_BASE_URL}${path}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    const ct = res.headers.get("content-type") || "";
    const buf = await res.arrayBuffer();
    if (!res.ok) {
      let body: unknown;
      try {
        const text = new TextDecoder().decode(buf);
        body = ct.includes("application/json") ? JSON.parse(text) : text;
      } catch {
        body = null;
      }
      log.error("openai multipart error", { path, status: res.status, body });
      throw new Error(`OpenAI error ${res.status}`);
    }
    const out: T = (ct.includes("application/json")
      ? (JSON.parse(new TextDecoder().decode(buf)) as unknown)
      : buf) as T;
    return out;
  } finally {
    clearTimeout(id);
  }
}

// JSON request that expects binary audio back
async function httpJsonBinary(path: string, body: any, accept: string, timeoutMs = 60000): Promise<ArrayBuffer> {
  const url = `${OPENAI_BASE_URL}${path}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept,
        authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let errBody: unknown = null;
      const ct = res.headers.get("content-type") || "";
      try {
        if (ct.includes("application/json")) {
          const text = await res.text();
          errBody = text ? JSON.parse(text) : null;
        } else {
          errBody = await res.text().catch(() => null);
        }
      } catch {
        errBody = null;
      }
      log.error("openai http error", { path, status: res.status, err: errBody });
      throw new Error(`OpenAI error ${res.status}`);
    }
    return await res.arrayBuffer();
  } finally {
    clearTimeout(id);
  }
}

async function withRetry<T>(fn: () => Promise<T>, label: string, max = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (error: unknown) {
      last = error;
      const msg = extractErrorMessage(error);
      const retryable = /(429|5\d\d|aborted|timeout)/i.test(msg);
      if (!retryable || i === max - 1) break;
      const backoff = 250 * Math.pow(2, i) + Math.floor(Math.random() * 100);
      log.warn("openai retry", { label, attempt: i + 1, backoff_ms: backoff, err: safeError(error) });
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  if (last instanceof Error) throw last;
  throw new Error(extractErrorMessage(last));
}

// -------- Chat --------------------------------------------------------

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const model = opts.model || process.env.OPENAI_CHAT_MODEL;
  if (!model) {
    throw new Error(
      "OPENAI_CHAT_MODEL is not set. Configure it to your preferred latest OpenAI chat model.",
    );
  }
  const messages = opts.system ? [{ role: "system" as const, content: opts.system }, ...opts.messages] : opts.messages;
  const payload: ChatPayload = {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens,
    ...opts.extra,
  };
  if (opts.json) payload.response_format = { type: "json_object" };

  const run = () => httpJson<ChatCompletionResponse>(`/chat/completions`, payload, opts.timeoutMs ?? 30000);
  const data = await withRetry(run, "chat");

  const choice = data.choices?.[0];
  const content = choice?.message?.content;

  const text: string | undefined = normalizeChatContent(content);

  let parsed: unknown = undefined;
  if (opts.json && typeof text === "string") {
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep undefined
    }
  }

  return {
    text,
    json: parsed,
    finish_reason: choice?.finish_reason,
    usage: data?.usage,
    raw: data,
  };
}

// -------- Embeddings --------------------------------------------------

export async function embed(opts: EmbeddingOptions): Promise<number[][]> {
  const model = opts.model || process.env.OPENAI_EMBED_MODEL;
  if (!model) {
    throw new Error(
      "OPENAI_EMBED_MODEL is not set. Configure it to your preferred latest OpenAI embedding model.",
    );
  }
  const payload = { model, input: opts.input };
  const run = () => httpJson<EmbeddingResponse>(`/embeddings`, payload, opts.timeoutMs ?? 20000);
  const data = await withRetry(run, "embeddings");
  const vecs: number[][] = (data.data ?? []).map((d: EmbeddingResult) => d.embedding);
  return vecs;
}

// -------- Moderations -------------------------------------------------

export async function moderate(opts: ModerationOptions): Promise<ModerationResponse> {
  const model = opts.model || process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest";
  const payload = { model, input: opts.input };
  const run = () => httpJson<ModerationResponse>(`/moderations`, payload, opts.timeoutMs ?? 15000);
  return withRetry(run, "moderations");
}

// -------- Transcriptions (STT) ---------------------------------------

export async function transcribe(opts: TranscribeOptions): Promise<{ text: string; raw: TranscriptionResponse }> {
  const model = opts.model || process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";

  // Ensure we can build a Blob and FormData in this runtime
  if (typeof FormData === "undefined" || typeof Blob === "undefined") {
    throw new Error("This runtime lacks FormData/Blob. Enable undici fetch in Node 18+");
  }

  const blob = toBlob(opts.file, "audio/webm");
  const form = new FormData();
  form.append("file", blob, opts.filename || `audio-${Date.now()}.webm`);
  form.append("model", model);
  if (opts.language) form.append("language", opts.language);
  if (opts.temperature != null) form.append("temperature", String(opts.temperature));

  const run = () => httpMultipart<TranscriptionResponse>(`/audio/transcriptions`, form, opts.timeoutMs ?? 60000);
  const data = await withRetry(run, "transcribe");
  const text =
    typeof data.text === "string"
      ? data.text
      : (() => {
          try {
            return JSON.stringify(data);
          } catch {
            return "";
          }
        })();
  return { text, raw: data };
}

// -------- Text to Speech (TTS) ---------------------------------------

export async function tts(opts: TtsOptions): Promise<{ audio: Uint8Array; contentType: string }> {
  const model = opts.model || process.env.OPENAI_TTS_MODEL;
  if (!model) {
    throw new Error(
      "OPENAI_TTS_MODEL is not set. Configure it to your preferred latest OpenAI TTS model.",
    );
  }
  const voice = opts.voice || process.env.OPENAI_TTS_VOICE || "alloy";
  const envFormat = process.env.OPENAI_TTS_FORMAT;
  let format: TtsFormat = "mp3";
  if (opts.format) {
    format = opts.format;
  } else if (typeof envFormat === "string" && isTtsFormat(envFormat)) {
    format = envFormat;
  }

  // JSON request that returns binary audio
  const payload = { model, voice, input: opts.input, format, speed: opts.speed };
  const run = () => httpJsonBinary(`/audio/speech`, payload, `audio/${format}`, opts.timeoutMs ?? 60000);
  const buf = await withRetry(run, "tts");
  return { audio: new Uint8Array(buf), contentType: `audio/${format}` };
}

// -------- Utils -------------------------------------------------------

function toBlob(data: Blob | ArrayBuffer | Uint8Array, mime = "application/octet-stream"): Blob {
  if (data instanceof Blob) return data;
  if (data instanceof Uint8Array) {
    // Ensure ArrayBuffer, not SharedArrayBuffer, and respect view window
    const ab = toArrayBufferCopy(data);
    return new Blob([ab], { type: mime });
  }
  // data is ArrayBuffer
  return new Blob([data], { type: mime });
}

function toArrayBufferCopy(u8: Uint8Array): ArrayBuffer {
  // Create a fresh ArrayBuffer with just the view window.
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeChatContent(content: ChatCompletionMessage["content"]): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts = content;
  const joined = parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part.text === "string") return part.text;
      const nested = (part as { text?: { value?: string } }).text;
      if (nested && typeof nested.value === "string") return nested.value;
      return "";
    })
    .join("");

  return joined || undefined;
}

interface EmbeddingResult {
  embedding: number[];
}

interface EmbeddingResponse {
  data: EmbeddingResult[];
}

interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  [key: string]: unknown;
}

interface ModerationResponse {
  results: ModerationResult[];
  [key: string]: unknown;
}

interface TranscriptionResponse {
  text?: string;
  [key: string]: unknown;
}

function isTtsFormat(value: unknown): value is TtsFormat {
  return value === "mp3" || value === "wav" || value === "flac" || value === "opus";
}

// Example usage (non-streaming):
// const res = await chat({ system: "You are helpful", messages: [{ role: 'user', content: 'Hi' }] });
// console.log(res.text);
