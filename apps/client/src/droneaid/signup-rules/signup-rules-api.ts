import api from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";

export type SpaceGrantRole = "reader" | "writer" | "admin";

export type SignupRule = {
  id?: string;
  pattern: string;
  spaceIds: string[];
  spaceRole: SpaceGrantRole;
};

export type SignupRulesState = {
  rules: (SignupRule & { id: string; createdAt: string; updatedAt: string })[];
  allowGoogleSignup: boolean;
  googleConfigured: boolean;
  spaces: { id: string; name: string | null; slug: string }[];
};

export type SaveSignupRulesInput = {
  rules: SignupRule[];
  allowGoogleSignup: boolean;
};

const KEY = ["droneaid-signup-rules"];

export async function getSignupRules(): Promise<SignupRulesState> {
  const res = await api.post<SignupRulesState>("/droneaid/signup-rules");
  return res.data;
}

export async function saveSignupRules(
  input: SaveSignupRulesInput,
): Promise<SignupRulesState> {
  const res = await api.post<SignupRulesState>(
    "/droneaid/signup-rules/save",
    input,
  );
  return res.data;
}

export function useSignupRulesQuery() {
  return useQuery({ queryKey: KEY, queryFn: getSignupRules });
}

export function useSaveSignupRules() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveSignupRules,
    onSuccess: (data) => queryClient.setQueryData(KEY, data),
    onError: (error: any) =>
      notifications.show({
        message:
          error?.response?.data?.message ?? error?.message ?? "Request failed",
        color: "red",
      }),
  });
}
