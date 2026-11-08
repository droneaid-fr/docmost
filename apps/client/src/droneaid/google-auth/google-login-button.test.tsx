import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import enUS from "../../../public/locales/en-US/droneaid.json";
import frFR from "../../../public/locales/fr-FR/droneaid.json";
import { GoogleLoginButton } from "./google-login-button.tsx";
import { getGoogleAuthConfig } from "./google-auth-service.ts";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./google-auth-service.ts", () => ({
  GOOGLE_AUTH_START_URL: "/api/droneaid/auth/google",
  getGoogleAuthConfig: vi.fn(),
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

function renderAt(path: string) {
  const client = new QueryClient();
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <GoogleLoginButton />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("GoogleLoginButton", () => {
  it("renders nothing when Google sign-in is off", async () => {
    vi.mocked(getGoogleAuthConfig).mockResolvedValue({ enabled: false });
    renderAt("/login");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("google-login-button")).toBeNull();
  });

  it("links to the start route when on", async () => {
    vi.mocked(getGoogleAuthConfig).mockResolvedValue({ enabled: true });
    renderAt("/login");
    const button = await screen.findByTestId("google-login-button");
    expect(button.getAttribute("href")).toBe("/api/droneaid/auth/google");
    expect(screen.queryByTestId("google-auth-error")).toBeNull();
  });

  it("shows a known error code from the query string", async () => {
    vi.mocked(getGoogleAuthConfig).mockResolvedValue({ enabled: true });
    renderAt("/login?google_error=domain_not_allowed");
    const alert = await screen.findByTestId("google-auth-error");
    expect(alert.textContent).toBe("googleAuth.error.domain_not_allowed");
  });

  it("maps an unknown error code to the generic message", async () => {
    vi.mocked(getGoogleAuthConfig).mockResolvedValue({ enabled: true });
    renderAt("/login?google_error=<script>");
    const alert = await screen.findByTestId("google-auth-error");
    expect(alert.textContent).toBe("googleAuth.error.failed");
  });
});

describe("droneaid locale files", () => {
  const keys = (o: object, p = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === "object" ? keys(v, `${p}${k}.`) : [`${p}${k}`],
    );

  it("en-US and fr-FR have the same keys", () => {
    expect(keys(frFR).sort()).toEqual(keys(enUS).sort());
  });
});
