import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrandLogo } from "./brand-logo.tsx";
import { APP_NAME, BRAND_MARK_DARK, BRAND_MARK_LIGHT } from "./brand.ts";
import { getAppName } from "@/lib/config.ts";

const publicDir = resolve(__dirname, "../../../public");

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(cleanup);

describe("BrandLogo", () => {
  it("shows the DroneAid mark for each colour scheme and the product name", () => {
    render(
      <MantineProvider>
        <BrandLogo markSize={22} textSize="lg" />
      </MantineProvider>,
    );
    const light = screen.getByTestId("droneaid-brand-mark");
    const dark = screen.getByTestId("droneaid-brand-mark-dark");
    expect(light.getAttribute("src")).toBe(BRAND_MARK_LIGHT);
    expect(dark.getAttribute("src")).toBe(BRAND_MARK_DARK);
    expect(light.className).toContain("mantine-dark-hidden");
    expect(dark.className).toContain("mantine-light-hidden");
    expect(screen.getByText("DroneAid Base")).toBeTruthy();
  });

  it("is the app name used in document titles", () => {
    expect(getAppName()).toBe(APP_NAME);
  });

  it("references icons that exist in public/", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(publicDir, "manifest.json"), "utf8"),
    );
    expect(manifest.name).toBe(APP_NAME);
    const html = readFileSync(resolve(publicDir, "../index.html"), "utf8");
    const htmlIcons = [...html.matchAll(/href="(\/droneaid\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(htmlIcons.length).toBeGreaterThanOrEqual(4);
    const paths = [
      BRAND_MARK_LIGHT,
      BRAND_MARK_DARK,
      ...htmlIcons,
      ...manifest.icons.map((icon: { src: string }) => `/${icon.src}`),
    ];
    for (const path of paths) {
      expect(existsSync(resolve(publicDir, `.${path}`)), path).toBe(true);
    }
  });
});
