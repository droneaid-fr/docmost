/**
 * Translation configuration, read from env (root `.env`):
 *   TRANSLATE_ENABLED         `true` turns the feature on. Off by default.
 *   GEMINI_API_KEY            Google Gemini API key. Without it every job fails
 *                             with "not configured".
 *   GEMINI_MODEL              Model id. Default: gemini-3.5-flash-lite.
 *   TRANSLATE_GEMINI_BASE_URL Optional override of the Gemini REST base, for
 *                             tests against a fake server only.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const GEMINI_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

export interface TranslateConfig {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  baseUrl: string;
}

export type EnvGetter = (key: string) => string | undefined;

export function readTranslateConfig(get: EnvGetter): TranslateConfig {
  const enabled = ['true', '1', 'yes'].includes(
    (get('TRANSLATE_ENABLED') ?? '').trim().toLowerCase(),
  );
  return {
    enabled,
    apiKey: get('GEMINI_API_KEY')?.trim() || null,
    model: get('GEMINI_MODEL')?.trim() || DEFAULT_GEMINI_MODEL,
    baseUrl:
      get('TRANSLATE_GEMINI_BASE_URL')?.trim().replace(/\/+$/, '') ||
      GEMINI_API_BASE,
  };
}
