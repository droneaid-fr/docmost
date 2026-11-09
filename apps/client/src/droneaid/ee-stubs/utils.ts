// Core expects: getHostnameUrl(hostname) and exchangeTokenRedirectUrl(hostname, token), used on cloud only; both return this app's own URL.
import { getAppUrl } from "@/lib/config.ts";

export function getHostnameUrl(_hostname: string): string {
  return getAppUrl();
}

export function exchangeTokenRedirectUrl(_hostname: string, _exchangeToken: string): string {
  return getAppUrl();
}
