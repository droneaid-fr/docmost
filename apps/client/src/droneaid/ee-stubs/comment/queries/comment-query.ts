// Core expects: useResolveCommentMutation() -> { mutateAsync }; only reached when resolution is licensed, so it rejects.
import { unavailable } from "../../_lib/render-nothing";

export function useResolveCommentMutation() {
  return {
    mutateAsync: unavailable as (vars: {
      commentId: string;
      pageId: string;
      resolved: boolean;
    }) => Promise<never>,
  };
}
