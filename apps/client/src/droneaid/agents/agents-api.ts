import api from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";

export type AgentToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type Agent = {
  userId: string;
  name: string | null;
  email: string;
  deactivatedAt: string | null;
  spaceId: string | null;
  spaceName: string | null;
  spaceSlug: string | null;
  createdAt: string;
  tokens: AgentToken[];
};

export type CreateAgentInput = {
  name: string;
  email?: string;
  spaceName: string;
  spaceSlug: string;
};

const AGENTS_KEY = ["droneaid-agents"];

export async function listAgents(): Promise<Agent[]> {
  const res = await api.post<Agent[]>("/droneaid/agents");
  return res.data;
}

export async function createAgent(input: CreateAgentInput) {
  const res = await api.post("/droneaid/agents/create", input);
  return res.data;
}

export async function createAgentToken(input: {
  agentUserId: string;
  name: string;
  expiresInDays?: number;
}): Promise<{ token: string; record: AgentToken }> {
  const res = await api.post<{ token: string; record: AgentToken }>(
    "/droneaid/agents/tokens/create",
    input,
  );
  return res.data;
}

export async function revokeAgentToken(tokenId: string) {
  const res = await api.post("/droneaid/agents/tokens/revoke", { tokenId });
  return res.data;
}

function errorText(error: any): string {
  return error?.response?.data?.message ?? error?.message ?? "Request failed";
}

export function useAgentsQuery() {
  return useQuery({ queryKey: AGENTS_KEY, queryFn: listAgents });
}

function useAgentMutation<TIn, TOut>(fn: (input: TIn) => Promise<TOut>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AGENTS_KEY }),
    onError: (error) =>
      notifications.show({ message: errorText(error), color: "red" }),
  });
}

export const useCreateAgent = () => useAgentMutation(createAgent);
export const useCreateAgentToken = () => useAgentMutation(createAgentToken);
export const useRevokeAgentToken = () => useAgentMutation(revokeAgentToken);
