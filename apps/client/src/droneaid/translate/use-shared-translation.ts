import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { getSharedTranslation, SharedTranslation } from "./translate-api.ts";

export interface SharedTranslationState {
  /** `?lang=` as given (may be unknown: then the original is shown). */
  requested: string | null;
  sourceLang: string | null;
  languages: string[];
  /** The translation shown, or null for the original. */
  active: SharedTranslation["translation"];
  loading: boolean;
}

/**
 * Translations of a shared page for its public reader. `?lang=xx` picks one;
 * an unknown or unpublished language falls back to the original.
 */
export function useSharedTranslation(
  pageId: string | undefined,
): SharedTranslationState {
  const [params] = useSearchParams();
  const requested = params.get("lang");
  const { data, isLoading } = useQuery({
    queryKey: ["droneaid", "shared-translation", pageId, requested],
    queryFn: () => getSharedTranslation(pageId, requested),
    enabled: !!pageId,
    retry: false,
    staleTime: 60 * 1000,
  });
  return {
    requested,
    sourceLang: data?.sourceLang ?? null,
    languages: data?.languages ?? [],
    active: data?.translation ?? null,
    // Only wait when a language was asked for; the original never waits.
    loading: !!requested && !!pageId && isLoading,
  };
}
