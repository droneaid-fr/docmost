// Core expects: useAiSearch() -> a mutation-like object plus streaming fields; idle and empty here.
import { noop } from "../../_lib/render-nothing";

export function useAiSearch() {
  return {
    data: undefined as unknown,
    isPending: false,
    mutate: noop,
    reset: noop,
    error: null as Error | null,
    streamingAnswer: "",
    streamingSources: [] as unknown[],
    clearStreaming: noop,
  };
}
