// Core expects: BaseTableSkeleton({ rows, columns }) while an embed waits for its id; shows the neutral block.
import { NotAvailableBlock } from "../../_lib/not-available";

export function BaseTableSkeleton(_props: { rows?: number; columns?: number }) {
  return <NotAvailableBlock what="Base" />;
}
