import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { searchWithLang, ShareLanguageMenu } from "./share-language-menu.tsx";
import type { SharedTranslationState } from "./use-shared-translation.ts";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, o?: any) => (o?.language ? `${key}:${o.language}` : key),
  }),
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
afterEach(cleanup);

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

function renderMenu(state: SharedTranslationState, path = "/share/k/p/doc-1") {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ShareLanguageMenu translation={state} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}

const base: SharedTranslationState = {
  requested: null,
  sourceLang: "fr",
  languages: ["en", "de"],
  active: null,
  loading: false,
};

describe("ShareLanguageMenu", () => {
  it("is hidden when the page has no translations", () => {
    renderMenu({ ...base, languages: [] });
    expect(screen.queryByTestId("share-language-menu")).toBeNull();
  });

  it("shows the active language and switches with ?lang=", async () => {
    renderMenu(
      { ...base, active: { lang: "en", title: "T", content: {} } },
      "/share/k/p/doc-1?lang=en",
    );
    expect(screen.getByTestId("share-language-menu").textContent).toContain(
      "translate.language.en",
    );
    fireEvent.click(screen.getByTestId("share-language-menu"));
    fireEvent.click(await screen.findByTestId("share-language-de"));
    expect(screen.getByTestId("where").textContent).toBe(
      "/share/k/p/doc-1?lang=de",
    );
    fireEvent.click(screen.getByTestId("share-language-menu"));
    fireEvent.click(await screen.findByTestId("share-language-original"));
    expect(screen.getByTestId("where").textContent).toBe("/share/k/p/doc-1");
  });

  it("keeps other query parameters", () => {
    expect(searchWithLang("?a=1", "fr")).toBe("?a=1&lang=fr");
    expect(searchWithLang("?lang=fr&a=1", null)).toBe("?a=1");
    expect(searchWithLang("?lang=fr", null)).toBe("");
  });
});
