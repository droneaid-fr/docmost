// Core expects: BaseView({ pageId, embedded?, editable?, titleSlot? }); shows a neutral "not available" block so the content is never dropped.
import type { ReactNode } from "react";
import { NotAvailableBlock } from "../../_lib/not-available";

type BaseViewProps = {
  pageId: string;
  embedded?: boolean;
  editable?: boolean;
  titleSlot?: ReactNode;
};

export function BaseView({ titleSlot }: BaseViewProps) {
  return (
    <>
      {titleSlot}
      <NotAvailableBlock what="Base" />
    </>
  );
}
