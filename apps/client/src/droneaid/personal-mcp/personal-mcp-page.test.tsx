import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import enUS from "../../../public/locales/en-US/droneaid.json";
import frFR from "../../../public/locales/fr-FR/droneaid.json";
import PersonalMcpPage from "./personal-mcp-page.tsx";
import {
  claudeCodeCommand,
  mcpClientConfigJson,
  MCP_SERVER_NAME,
} from "./mcp-client-config";
import api from "@/lib/api-client";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/api-client", () => ({ default: { post: vi.fn() } }));

const TOKEN = `dmcpu_${"a".repeat(43)}`;
const post = () => vi.mocked(api.post);
const calls = (url: string) => post().mock.calls.filter(([u]) => u === url);

function serve(state: unknown) {
  post().mockImplementation(async (url: string) => {
    if (url === "/droneaid/personal-tokens/create") {
      return { data: { token: TOKEN, record: {} } } as any;
    }
    return { data: state } as any;
  });
}

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

const token = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "laptop",
  tokenPrefix: "dmcpu_abcdef",
  createdAt: "2026-11-09T10:00:00Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

function renderPage() {
  return render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <PersonalMcpPage />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("PersonalMcpPage", () => {
  it("shows the endpoint and the caller's tokens by prefix", async () => {
    serve({ allowed: true, maxActive: 10, tokens: [token()] });
    renderPage();
    const table = await screen.findByTestId("personal-mcp-tokens");
    expect(table.textContent).toContain("laptop");
    expect(table.textContent).toContain("dmcpu_abcdef…");
    expect(screen.getByTestId("personal-mcp-endpoint").textContent).toMatch(
      /\/api\/droneaid\/mcp$/,
    );
  });

  it("creates a token, reveals it once with an example config", async () => {
    serve({ allowed: true, maxActive: 10, tokens: [] });
    renderPage();
    fireEvent.click(await screen.findByText("personalMcp.create"));
    fireEvent.change(await screen.findByLabelText(/personalMcp.name/), {
      target: { value: "Claude" },
    });
    fireEvent.click(screen.getByText("personalMcp.createSubmit"));
    const reveal = await screen.findByTestId("personal-mcp-reveal");
    expect(calls("/droneaid/personal-tokens/create")[0][1]).toEqual({
      name: "Claude",
      expiresInDays: 90,
    });
    expect(screen.getByTestId("personal-mcp-token").textContent).toBe(TOKEN);
    expect(reveal.textContent).toContain(`"Authorization": "Bearer ${TOKEN}"`);
    expect(reveal.textContent).toContain("/api/droneaid/mcp");
  });

  it("disables creation at the cap", async () => {
    serve({
      allowed: true,
      maxActive: 1,
      tokens: [token(), token({ id: "t2", revokedAt: "2026-11-09T11:00:00Z" })],
    });
    renderPage();
    const button = await screen.findByRole("button", {
      name: "personalMcp.create",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("personalMcp.revoked")).toBeTruthy();
  });

  it("revokes after confirmation", async () => {
    serve({ allowed: true, maxActive: 10, tokens: [token()] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    fireEvent.click(await screen.findByText("personalMcp.revoke"));
    await vi.waitFor(() =>
      expect(calls("/droneaid/personal-tokens/revoke")[0][1]).toEqual({
        tokenId: "t1",
      }),
    );
  });

  it("tells an agent account it cannot have tokens", async () => {
    serve({ allowed: false, maxActive: 10, tokens: [] });
    renderPage();
    expect(await screen.findByText("personalMcp.agentRefused")).toBeTruthy();
    expect(screen.queryByText("personalMcp.create")).toBeNull();
  });
});

describe("MCP client config", () => {
  it("is valid mcpServers JSON with the bearer header", () => {
    const parsed = JSON.parse(mcpClientConfigJson("https://x/api/droneaid/mcp", TOKEN));
    expect(parsed.mcpServers[MCP_SERVER_NAME]).toEqual({
      type: "http",
      url: "https://x/api/droneaid/mcp",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(claudeCodeCommand("https://x/api/droneaid/mcp", TOKEN)).toContain(
      `--transport http ${MCP_SERVER_NAME} https://x/api/droneaid/mcp`,
    );
  });
});

describe("personalMcp strings", () => {
  const keys = (o: object, prefix = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    );
  it("exist in English and French alike", () => {
    expect(keys(frFR.personalMcp).sort()).toEqual(keys(enUS.personalMcp).sort());
  });
});
