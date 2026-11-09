// Shared helpers for the Enterprise stubs: a component that renders nothing and a no-op.
export function RenderNothing(_props: Record<string, unknown>): null {
  return null;
}

export function noop(..._args: unknown[]): void {}

export function unavailable(): Promise<never> {
  return Promise.reject(new Error("Not available in this edition"));
}
