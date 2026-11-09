import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import {
  isActive,
  PersonalToken,
  useCreatePersonalToken,
  usePersonalTokensQuery,
  useRevokePersonalToken,
} from "./personal-mcp-api";
import {
  claudeCodeCommand,
  mcpClientConfigJson,
  mcpEndpointUrl,
} from "./mcp-client-config";

/** Long tokens and URLs wrap instead of overflowing the modal. */
const WRAP = { whiteSpace: "pre-wrap", wordBreak: "break-all" } as const;

const EXPIRY_CHOICES = ["30", "90", "365", "never"] as const;

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function CopyLine({ value, label }: { value: string; label: string }) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => (
        <Button size="xs" variant="default" onClick={copy}>
          {copied ? "✓" : label}
        </Button>
      )}
    </CopyButton>
  );
}

function TokenReveal({ token, url }: { token: string; url: string }) {
  const { t } = useTranslation("droneaid");
  const config = mcpClientConfigJson(url, token);
  const command = claudeCodeCommand(url, token);
  return (
    <Stack data-testid="personal-mcp-reveal">
      <Alert color="yellow">{t("personalMcp.showOnce")}</Alert>
      <Code block style={WRAP} data-testid="personal-mcp-token">
        {token}
      </Code>
      <Group>
        <CopyLine value={token} label={t("personalMcp.copyToken")} />
      </Group>
      <Text size="sm" fw={600}>
        {t("personalMcp.exampleConfig")}
      </Text>
      <Code block style={WRAP}>
        {config}
      </Code>
      <Group>
        <CopyLine value={config} label={t("personalMcp.copyConfig")} />
      </Group>
      <Text size="sm" fw={600}>
        {t("personalMcp.claudeCode")}
      </Text>
      <Code block style={WRAP}>
        {command}
      </Code>
      <Group>
        <CopyLine value={command} label={t("personalMcp.copyCommand")} />
      </Group>
    </Stack>
  );
}

function CreateTokenButton({
  disabled,
  url,
}: {
  disabled: boolean;
  url: string;
}) {
  const { t } = useTranslation("droneaid");
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>("90");
  const [token, setToken] = useState<string | null>(null);
  const create = useCreatePersonalToken();

  const onClose = () => {
    setToken(null);
    setName("");
    close();
  };
  const onCreate = async () => {
    const result = await create.mutateAsync({
      name,
      expiresInDays: expiry === "never" ? undefined : Number(expiry),
    });
    setToken(result.token);
  };

  return (
    <>
      <Button onClick={open} disabled={disabled}>
        {t("personalMcp.create")}
      </Button>
      <Modal
        opened={opened}
        onClose={onClose}
        size="lg"
        title={token ? t("personalMcp.newToken") : t("personalMcp.create")}
      >
        {token ? (
          <TokenReveal token={token} url={url} />
        ) : (
          <Stack>
            <TextInput
              label={t("personalMcp.name")}
              placeholder={t("personalMcp.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={100}
              required
              data-autofocus
            />
            <Select
              label={t("personalMcp.expiry")}
              value={expiry}
              onChange={(value) => setExpiry(value ?? "90")}
              allowDeselect={false}
              data={EXPIRY_CHOICES.map((value) => ({
                value,
                label: t(`personalMcp.expiryChoice.${value}`),
              }))}
            />
            <Group justify="flex-end">
              <Button
                onClick={onCreate}
                loading={create.isPending}
                disabled={name.trim().length < 1}
              >
                {t("personalMcp.createSubmit")}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function StatusCell({ token }: { token: PersonalToken }) {
  const { t } = useTranslation("droneaid");
  const revoke = useRevokePersonalToken();
  if (token.revokedAt) {
    return <Badge color="gray">{t("personalMcp.revoked")}</Badge>;
  }
  if (!isActive(token)) {
    return <Badge color="gray">{t("personalMcp.expired")}</Badge>;
  }
  return (
    <Button
      size="xs"
      color="red"
      variant="light"
      loading={revoke.isPending}
      onClick={() => {
        if (window.confirm(t("personalMcp.revokeConfirm", { name: token.name }))) {
          revoke.mutate(token.id);
        }
      }}
    >
      {t("personalMcp.revoke")}
    </Button>
  );
}

function TokenTable({ tokens }: { tokens: PersonalToken[] }) {
  const { t } = useTranslation("droneaid");
  if (tokens.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t("personalMcp.none")}
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table data-testid="personal-mcp-tokens">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("personalMcp.name")}</Table.Th>
            <Table.Th>{t("personalMcp.token")}</Table.Th>
            <Table.Th>{t("personalMcp.created")}</Table.Th>
            <Table.Th>{t("personalMcp.lastUsed")}</Table.Th>
            <Table.Th>{t("personalMcp.expires")}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tokens.map((token) => (
            <Table.Tr key={token.id}>
              <Table.Td>{token.name}</Table.Td>
              <Table.Td>
                <Code>{token.tokenPrefix}…</Code>
              </Table.Td>
              <Table.Td>{formatDate(token.createdAt)}</Table.Td>
              <Table.Td>{formatDate(token.lastUsedAt)}</Table.Td>
              <Table.Td>
                {token.expiresAt
                  ? formatDate(token.expiresAt)
                  : t("personalMcp.never")}
              </Table.Td>
              <Table.Td>
                <StatusCell token={token} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export default function PersonalMcpPage() {
  const { t } = useTranslation("droneaid");
  const { data, isLoading } = usePersonalTokensQuery();
  const url = mcpEndpointUrl();

  const title = (
    <>
      <DocumentTitle title={t("personalMcp.title")} />
      <SettingsTitle title={t("personalMcp.title")} />
    </>
  );
  if (isLoading || !data) {
    return (
      <>
        {title}
        <Text>{t("personalMcp.loading")}</Text>
      </>
    );
  }
  if (!data.allowed) {
    return (
      <>
        {title}
        <Text>{t("personalMcp.agentRefused")}</Text>
      </>
    );
  }

  const active = data.tokens.filter((token) => isActive(token)).length;
  const atCap = active >= data.maxActive;
  return (
    <>
      {title}
      <Text size="sm" c="dimmed" mb="md">
        {t("personalMcp.intro")}
      </Text>
      <Group gap="xs" mb="md" wrap="nowrap">
        <Text size="sm">{t("personalMcp.endpoint")}</Text>
        <Code data-testid="personal-mcp-endpoint">{url}</Code>
        <CopyLine value={url} label={t("personalMcp.copy")} />
      </Group>
      <Group my="md" justify="space-between">
        <Text size="sm" c={atCap ? "red" : "dimmed"}>
          {t("personalMcp.activeCount", { active, max: data.maxActive })}
        </Text>
        <CreateTokenButton disabled={atCap} url={url} />
      </Group>
      <TokenTable tokens={data.tokens} />
    </>
  );
}
