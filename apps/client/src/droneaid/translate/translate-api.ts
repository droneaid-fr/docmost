import api from "@/lib/api-client";

export type TranslationStatus = "pending" | "running" | "ready" | "failed";

export interface PageTranslation {
  lang: string;
  sourceLang: string;
  status: TranslationStatus;
  error: string | null;
  translatedAt: string | null;
  available: boolean;
  /** Edited since translated: readers see the original until it is redone. */
  outOfDate: boolean;
}

export interface PageTranslations {
  enabled: boolean;
  canManage: boolean;
  published: boolean;
  languages: string[];
  sourceLang: string | null;
  translations: PageTranslation[];
  /** Edited pages are translated again after this many minutes without edits. */
  refreshQuietMinutes?: number;
}

export interface SharedTranslation {
  sourceLang: string | null;
  languages: string[];
  translation: { lang: string; title: string | null; content: any } | null;
}

export async function getPageTranslations(
  pageId: string,
): Promise<PageTranslations> {
  const req = await api.post<PageTranslations>("/droneaid/translate/page", {
    pageId,
  });
  return req.data;
}

export async function setPageTranslations(input: {
  pageId: string;
  sourceLang: string;
  languages: string[];
}): Promise<PageTranslations> {
  const req = await api.post<PageTranslations>(
    "/droneaid/translate/page/set",
    input,
  );
  return req.data;
}

export async function updatePageTranslations(
  pageId: string,
): Promise<PageTranslations> {
  const req = await api.post<PageTranslations>(
    "/droneaid/translate/page/update",
    { pageId },
  );
  return req.data;
}

export async function getSharedTranslation(
  pageId: string,
  lang: string | null,
): Promise<SharedTranslation> {
  const req = await api.post<SharedTranslation>("/droneaid/translate/shared", {
    pageId,
    ...(lang ? { lang } : {}),
  });
  return req.data;
}
