import { Alert, Button, Divider } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { GoogleIcon } from "@/components/icons/google-icon.tsx";
import {
  getGoogleAuthConfig,
  GOOGLE_AUTH_START_URL,
} from "./google-auth-service.ts";

// Codes sent by the server as /login?google_error=<code>; anything else shows "failed".
const KNOWN_ERRORS = [
  "email_not_verified",
  "missing_email",
  "account_disabled",
  "account_conflict",
  "signup_disabled",
  "domain_not_allowed",
  "not_configured",
  "state_mismatch",
  "cancelled",
  "failed",
];

interface Props {
  /** Show the "or" divider below the button (when a password form follows). */
  withDivider?: boolean;
}

export function GoogleLoginButton({ withDivider = true }: Props) {
  const { t } = useTranslation("droneaid");
  const [searchParams] = useSearchParams();
  const { data } = useQuery({
    queryKey: ["droneaid", "google-auth-config"],
    queryFn: getGoogleAuthConfig,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const rawError = searchParams.get("google_error");
  const error = rawError
    ? KNOWN_ERRORS.includes(rawError)
      ? rawError
      : "failed"
    : null;

  if (!data?.enabled) return null;

  return (
    <>
      {error && (
        <Alert color="red" mb="md" role="alert" data-testid="google-auth-error">
          {t(`googleAuth.error.${error}`)}
        </Alert>
      )}
      <Button
        component="a"
        href={GOOGLE_AUTH_START_URL}
        fullWidth
        variant="default"
        leftSection={<GoogleIcon size={18} />}
        data-testid="google-login-button"
      >
        {t("googleAuth.continue")}
      </Button>
      {withDivider && (
        <Divider my="md" label={t("googleAuth.or")} labelPosition="center" />
      )}
    </>
  );
}

export default GoogleLoginButton;
