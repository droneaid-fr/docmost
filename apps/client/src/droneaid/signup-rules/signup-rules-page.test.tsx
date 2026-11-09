import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import enUS from "../../../public/locales/en-US/droneaid.json";
import frFR from "../../../public/locales/fr-FR/droneaid.json";
import SignupRulesPage from "./signup-rules-page.tsx";
import api from "@/lib/api-client";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, opts?: { value?: string }) =>
      opts?.value ? `${key}:${opts.value}` : key,
  }),
}));

vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: true }),
}));

vi.mock("@/lib/api-client", () => ({ default: { post: vi.fn() } }));

// The API module calls api.post(url, body) and returns `res.data`.
const post = () => vi.mocked(api.post);
function serve(state: unknown) {
  post().mockImplementation(async () => ({ data: state }) as any);
}
const saveCalls = () =>
  post().mock.calls.filter(([url]) => url === "/droneaid/signup-rules/save");

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
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const STATE = {
  rules: [
    {
      id: "r1",
      pattern: "*.droneaid.fr",
      spaceIds: ["s1"],
      spaceRole: "writer" as const,
      createdAt: "",
      updatedAt: "",
    },
  ],
  allowGoogleSignup: true,
  googleConfigured: true,
  spaces: [{ id: "s1", name: "General", slug: "general" }],
};

function renderPage() {
  const client = new QueryClient();
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <SignupRulesPage />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("SignupRulesPage", () => {
  it("shows one card per rule with a plain-language preview", async () => {
    serve(STATE);
    renderPage();
    const preview = await screen.findByTestId("signup-rule-preview");
    expect(preview.textContent).toBe("signupRules.preview.wildcard:droneaid.fr");
    expect(screen.getAllByTestId(/^signup-rule-\d+$/)).toHaveLength(1);
  });

  it("refuses to save a pattern that can never match", async () => {
    serve({ ...STATE, rules: [] });
    renderPage();
    await screen.findByText("signupRules.empty");
    fireEvent.click(screen.getByTestId("signup-rules-add"));
    const input = screen.getByTestId("signup-rule-pattern");
    fireEvent.change(input, { target: { value: "*@example.com" } });
    expect(screen.getByTestId("signup-rule-preview").textContent).toBe(
      "signupRules.problem.address_wildcard",
    );
    fireEvent.click(screen.getByTestId("signup-rules-save"));
    expect(await screen.findByTestId("signup-rules-invalid")).toBeTruthy();
    expect(saveCalls()).toHaveLength(0);
  });

  it("refuses to save an empty pattern", async () => {
    serve({ ...STATE, rules: [] });
    renderPage();
    await screen.findByText("signupRules.empty");
    fireEvent.click(screen.getByTestId("signup-rules-add"));
    fireEvent.click(screen.getByTestId("signup-rules-save"));
    expect(await screen.findByTestId("signup-rules-invalid")).toBeTruthy();
    expect(saveCalls()).toHaveLength(0);
  });

  it("saves the rules and the Google switch", async () => {
    serve(STATE);
    renderPage();
    await screen.findByTestId("signup-rule-preview");
    fireEvent.click(screen.getByTestId("signup-rules-save"));
    await vi.waitFor(() =>
      expect(saveCalls()[0]?.[1]).toEqual(
        {
          allowGoogleSignup: true,
          rules: [
            {
              id: "r1",
              pattern: "*.droneaid.fr",
              spaceIds: ["s1"],
              spaceRole: "writer",
            },
          ],
        },
      ),
    );
  });
});

describe("droneaid locale files", () => {
  const keys = (o: object, p = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`],
    );

  it("en-US and fr-FR have the same signup-rule keys", () => {
    expect(keys(frFR).sort()).toEqual(keys(enUS).sort());
    expect(keys(enUS)).toContain("signupRules.problem.misplaced_wildcard");
  });
});
