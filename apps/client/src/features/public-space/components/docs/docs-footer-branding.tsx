import clsx from "clsx";
import styles from "./docs.module.css";
import SourceCodeLink from "@/droneaid/source/source-code-link.tsx";

export default function DocsFooterBranding({
  className,
  refSource = "public-space",
}: {
  className?: string;
  refSource?: string;
}) {
  return (
    <footer className={clsx(styles.footer, className)}>
      <a
        className={styles.footerBranding}
        href={`https://docmost.com?ref=${refSource}`}
        target="_blank"
        rel="noreferrer"
      >
        Powered by Docmost
      </a>
      {/* DroneAid: AGPL §13 source offer on public share and space pages */}
      <span className={styles.footerBranding}> · </span>
      <SourceCodeLink className={styles.footerBranding} />
    </footer>
  );
}
