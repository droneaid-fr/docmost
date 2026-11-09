/**
 * Text search configuration for page full-text search (`pages.tsv`, the
 * search query and ts_headline). It is a database object created by the
 * migration `20261109T180000-droneaid-french-search.ts` as a copy of
 * Postgres's `french` configuration; upstream uses `english`.
 *
 * The trigger that fills `pages.tsv` and the query must use the same
 * configuration, so it is one fixed name rather than an env var. To change
 * the language, alter or recreate this configuration in a new migration and
 * rebuild `pages.tsv` (UPDATE pages SET title = title).
 */
export const PAGE_SEARCH_TS_CONFIG = 'droneaid_search';
