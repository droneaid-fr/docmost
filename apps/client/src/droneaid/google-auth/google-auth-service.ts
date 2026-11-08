import api from "@/lib/api-client";

export const GOOGLE_AUTH_START_URL = "/api/droneaid/auth/google";

export async function getGoogleAuthConfig(): Promise<{ enabled: boolean }> {
  const req = await api.get<{ enabled: boolean }>("/droneaid/auth/google/config");
  return req.data;
}
