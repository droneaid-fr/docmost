import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import enUS from "../../../public/locales/en-US/droneaid.json";
import frFR from "../../../public/locales/fr-FR/droneaid.json";
import { SourceCodeLink } from "./source-code-link.tsx";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("SourceCodeLink", () => {
  it("links our fork, never upstream, in a new tab", () => {
    render(<SourceCodeLink />);
    const link = screen.getByTestId("droneaid-source-link");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/droneaid-fr/docmost/tree/droneaid",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.textContent).toBe("source.link");
  });

  it("has every string in both locales", () => {
    for (const locale of [enUS, frFR]) {
      for (const key of ["link", "title", "version", "versionDev"]) {
        expect(locale.source[key as keyof typeof locale.source]).toBeTruthy();
      }
      expect(locale.source.link).toContain("AGPL-3.0");
      expect(locale.source.version).toContain("{{commit}}");
    }
  });
});
