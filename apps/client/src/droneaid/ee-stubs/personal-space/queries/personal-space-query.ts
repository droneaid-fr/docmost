// Core expects: usePersonalSpaceQuery(enabled) -> { data?: { slug } }; never a personal space here.
export function usePersonalSpaceQuery(_enabled: boolean): { data: { slug: string } | undefined } {
  return { data: undefined };
}
