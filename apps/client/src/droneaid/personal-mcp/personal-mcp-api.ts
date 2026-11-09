import api from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";

export type PersonalToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type PersonalTokensState = {
  /** False for agent accounts: they never get personal tokens. */
  allowed: boolean;
  maxActive: number;
  tokens: PersonalToken[];
};

export const PERSONAL_TOKENS_KEY = ["droneaid-personal-tokens"];

export async function listPersonalTokens(): Promise<PersonalTokensState> {
  const res = await api.post<PersonalTokensState>("/droneaid/personal-tokens");
  return res.data;
}

export async function createPersonalToken(input: {
  name: string;
  expiresInDays?: number;
}): Promise<{ token: string; record: PersonalToken }> {
  const res = await api.post<{ token: string; record: PersonalToken }>(
    "/droneaid/personal-tokens/create",
    input,
  );
  return res.data;
}

export async function revokePersonalToken(tokenId: string) {
  const res = await api.post("/droneaid/personal-tokens/revoke", { tokenId });
  return res.data;
}

function errorText(error: any): string {
  const message = error?.response?.data?.message ?? error?.message;
  return Array.isArray(message) ? message.join(", ") : message ?? "Request failed";
}

export function usePersonalTokensQuery() {
  return useQuery({
    queryKey: PERSONAL_TOKENS_KEY,
    queryFn: listPersonalTokens,
  });
}

function usePersonalTokenMutation<TIn, TOut>(
  fn: (input: TIn) => Promise<TOut>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: PERSONAL_TOKENS_KEY }),
    onError: (error) =>
      notifications.show({ message: errorText(error), color: "red" }),
  });
}

export const useCreatePersonalToken = () =>
  usePersonalTokenMutation(createPersonalToken);
export const useRevokePersonalToken = () =>
  usePersonalTokenMutation(revokePersonalToken);

export function isActive(token: PersonalToken, now = Date.now()): boolean {
  if (token.revokedAt) return false;
  return !token.expiresAt || new Date(token.expiresAt).getTime() > now;
}

/**
 * For the settings sidebar: show "MCP tokens" only once the server says this
 * account may hold them (agent accounts may not).
 */
export function usePersonalMcpAllowed(): boolean {
  return usePersonalTokensQuery().data?.allowed === true;
}
