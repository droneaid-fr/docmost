import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BaseView } from "@/ee/base/components/base-view";
import { BaseTableSkeleton } from "@/ee/base/components/base-table-skeleton";
// Plain functions in these stubs; aliased so the hooks lint rule does not apply.
import { useHasFeature as hasFeatureStub } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";
import { useUpgradeLabel as upgradeLabelStub } from "@/ee/hooks/use-upgrade-label";
import SsoLogin from "@/ee/components/sso-login.tsx";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, o?: any) => (o?.what ? `${key}:${o.what}` : key),
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

describe("Enterprise stubs", () => {
  it("report every licence feature as off", () => {
    for (const key of Object.values(Feature)) expect(hasFeatureStub(key)).toBe(false);
    expect(upgradeLabelStub()).toBeNull();
  });

  it("render a Base as a neutral block, keeping the title slot", () => {
    render(
      <MantineProvider>
        <BaseView pageId="p1" titleSlot={<h1>My base</h1>} />
        <BaseTableSkeleton rows={1} columns={3} />
      </MantineProvider>,
    );
    expect(screen.getByText("My base")).toBeTruthy();
    expect(screen.getAllByTestId("ee-not-available")).toHaveLength(2);
    expect(screen.getAllByText("eeStubs.notAvailable:Base")).toHaveLength(2);
  });

  it("render no SSO buttons", () => {
    render(
      <MantineProvider>
        <SsoLogin />
      </MantineProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
