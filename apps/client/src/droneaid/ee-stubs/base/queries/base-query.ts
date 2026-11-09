// Core expects: useBaseQuery(pageId) and useConvertPageToBaseMutation(); an idle, empty query and an inert mutation.
import { noop } from "../../_lib/render-nothing";

type BaseInfo = { permissions?: { canEdit?: boolean } };

export function useBaseQuery(_pageId: string) {
  return {
    data: undefined as BaseInfo | undefined,
    isLoading: false,
    isError: false,
  };
}

export function useConvertPageToBaseMutation() {
  return { mutate: noop as (vars: { pageId: string; template?: string }) => void, isPending: false };
}
