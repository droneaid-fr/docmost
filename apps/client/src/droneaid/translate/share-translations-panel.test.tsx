import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ShareTranslationsPanel } from "./share-translations-panel.tsx";
import { PageTranslationsButton } from "./page-translations-button.tsx";
import {
  getPageTranslations,
  PageTranslations,
  setPageTranslations,
  updatePageTranslations,
} from "./translate-api.ts";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./translate-api.ts", () => ({
  getPageTranslations: vi.fn(),
  setPageTranslations: vi.fn(),
  updatePageTranslations: vi.fn(),
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

const LANGS = ["en", "fr", "es", "pt", "de", "pl", "nl"];
const state = (over: Partial<PageTranslations> = {}): PageTranslations => ({
  enabled: true,
  canManage: true,
  published: true,
  languages: LANGS,
  sourceLang: "fr",
  translations: [
    {
      lang: "en",
      sourceLang: "fr",
      status: "ready",
      error: null,
      translatedAt: null,
      available: true,
      outOfDate: true,
    },
    {
      lang: "de",
      sourceLang: "fr",
      status: "failed",
      error: "boom",
      translatedAt: null,
      available: false,
      outOfDate: false,
    },
  ],
  ...over,
});

function renderPanel() {
  const client = new QueryClient();
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ShareTranslationsPanel pageId="page-1" />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ShareTranslationsPanel", () => {
  it("renders nothing while the feature is off or the page is private", async () => {
    vi.mocked(getPageTranslations).mockResolvedValue(state({ enabled: false }));
    renderPanel();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("share-translations")).toBeNull();
  });

  it("shows source, targets without the source, statuses and the out-of-date flag", async () => {
    vi.mocked(getPageTranslations).mockResolvedValue(state());
    renderPanel();
    await screen.findByTestId("share-translations");
    expect(screen.queryByTestId("share-translation-fr")).toBeNull();
    expect(
      (screen.getByTestId("share-translation-en") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId("share-translation-es") as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByTestId("translation-status-en").dataset.status).toBe(
      "out-of-date",
    );
    expect(screen.getByTestId("translation-status-en").textContent).toBe(
      "translate.status.outOfDate",
    );
    expect(screen.getByTestId("translation-status-de").dataset.status).toBe(
      "failed",
    );
  });

  it("saves a ticked language with the current source", async () => {
    vi.mocked(getPageTranslations).mockResolvedValue(state());
    vi.mocked(setPageTranslations).mockResolvedValue(state());
    renderPanel();
    fireEvent.click(await screen.findByTestId("share-translation-es"));
    await waitFor(() =>
      expect(setPageTranslations).toHaveBeenCalledWith({
        pageId: "page-1",
        sourceLang: "fr",
        languages: ["en", "de", "es"],
      }),
    );
  });

  it("Update re-translates", async () => {
    vi.mocked(getPageTranslations).mockResolvedValue(state());
    vi.mocked(updatePageTranslations).mockResolvedValue(state());
    renderPanel();
    fireEvent.click(await screen.findByTestId("share-translations-update"));
    await waitFor(() =>
      expect(updatePageTranslations).toHaveBeenCalledWith("page-1"),
    );
  });

  it("is read-only for users who cannot share the page", async () => {
    vi.mocked(getPageTranslations).mockResolvedValue(
      state({ canManage: false }),
    );
    renderPanel();
    await screen.findByTestId("share-translations");
    expect(
      (screen.getByTestId("share-translation-es") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("share-translations-update") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("PageTranslationsButton", () => {
  const renderButton = () =>
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <PageTranslationsButton pageId="page-1" />
        </QueryClientProvider>
      </MantineProvider>,
    );

  it("is hidden until the page is shared to the web", async () => {
    vi.mocked(getPageTranslations).mockResolvedValue(
      state({ published: false }),
    );
    renderButton();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("page-translations-button")).toBeNull();
  });

  it("opens the panel when the page is public", async () => {
    vi.mocked(getPageTranslations).mockResolvedValue(state());
    renderButton();
    fireEvent.click(await screen.findByTestId("page-translations-button"));
    expect(await screen.findByTestId("share-translations")).toBeTruthy();
  });
});
