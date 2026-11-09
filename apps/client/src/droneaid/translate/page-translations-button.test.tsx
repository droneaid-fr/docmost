import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PageTranslationsButton } from "./page-translations-button.tsx";

const refetch = vi.fn();

vi.mock("./share-translations-panel.tsx", () => ({
  ShareTranslationsPanel: () => null,
  usePageTranslationsQuery: () => ({
    data: { enabled: true, published: true, translations: [] },
    refetch,
  }),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
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
afterEach(() => {
  cleanup();
  refetch.mockReset();
});

describe("PageTranslationsButton", () => {
  it("refetches when core's Share popover creates or deletes the page's share", () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MantineProvider>
          <PageTranslationsButton pageId="p1" />
        </MantineProvider>
      </QueryClientProvider>,
    );
    expect(refetch).not.toHaveBeenCalled();

    act(() => queryClient.setQueryData(["share-for-page", "other"], { id: "s0" }));
    expect(refetch).not.toHaveBeenCalled();

    act(() => queryClient.setQueryData(["share-for-page", "p1"], { id: "s1" }));
    expect(refetch).toHaveBeenCalledTimes(1);

    act(() =>
      queryClient.removeQueries({ queryKey: ["share-for-page", "p1"] }),
    );
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
