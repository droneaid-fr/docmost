import slugify from '@sindresorhus/slugify';

/**
 * Absolute page URL in the form the client routes (`/s/<space>/p/<slug>`),
 * built exactly like core's export does for page mentions
 * (ExportService.turnPageMentionsToLinks), so links match what users copy.
 */
export function pageUrl(
  baseUrl: string,
  spaceSlug: string,
  page: { slugId: string; title: string | null },
): string {
  const title = (page.title || 'untitled').substring(0, 70);
  return `${baseUrl}/s/${spaceSlug}/p/${slugify(title)}-${page.slugId}`;
}

export function spaceUrl(baseUrl: string, spaceSlug: string): string {
  return `${baseUrl}/s/${spaceSlug}`;
}

/** `[Title](url)`, the link form the agent pastes into replies and docs. */
export function markdownLink(title: string | null, url: string): string {
  const text = (title || 'untitled')
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `[${text || 'untitled'}](${url})`;
}
