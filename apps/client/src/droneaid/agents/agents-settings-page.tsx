import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import {
  Agent,
  useAgentsQuery,
  useCreateAgent,
  useCreateAgentToken,
  useRevokeAgentToken,
} from "./agents-api";

const MCP_PATH = "/api/droneaid/mcp";

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function CreateAgentModal() {
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const [spaceSlug, setSpaceSlug] = useState("");
  const create = useCreateAgent();

  const submit = async () => {
    await create.mutateAsync({ name, spaceName, spaceSlug });
    setName("");
    setSpaceName("");
    setSpaceSlug("");
    close();
  };

  return (
    <>
      <Button onClick={open}>Create agent</Button>
      <Modal opened={opened} onClose={close} title="Create agent">
        <Stack>
          <TextInput
            label="Agent name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
          />
          <TextInput
            label="Its own space"
            description="The agent is writer here. Grant it reader on other spaces through the space's members."
            value={spaceName}
            onChange={(e) => setSpaceName(e.currentTarget.value)}
            required
          />
          <TextInput
            label="Space slug"
            value={spaceSlug}
            onChange={(e) => setSpaceSlug(e.currentTarget.value)}
            required
          />
          <Group justify="flex-end">
            <Button
              onClick={submit}
              loading={create.isPending}
              disabled={
                name.length < 2 || spaceName.length < 2 || spaceSlug.length < 2
              }
            >
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function MintTokenButton({ agent }: { agent: Agent }) {
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState("hermes");
  const [token, setToken] = useState<string | null>(null);
  const mint = useCreateAgentToken();

  const onClose = () => {
    setToken(null);
    close();
  };
  const onMint = async () => {
    const result = await mint.mutateAsync({ agentUserId: agent.userId, name });
    setToken(result.token);
  };

  return (
    <>
      <Button size="xs" variant="default" onClick={open}>
        Mint token
      </Button>
      <Modal
        opened={opened}
        onClose={onClose}
        title={token ? "New agent token" : `Mint a token for ${agent.name}`}
      >
        {token ? (
          <Stack>
            <Alert color="yellow">
              Copy it now. It is shown only once; only its hash is stored.
            </Alert>
            <Code block>{token}</Code>
            <Text size="sm">
              Endpoint: <Code>{window.location.origin + MCP_PATH}</Code>, header{" "}
              <Code>Authorization: Bearer &lt;token&gt;</Code>
            </Text>
            <CopyButton value={token}>
              {({ copied, copy }) => (
                <Button onClick={copy}>
                  {copied ? "Copied" : "Copy token"}
                </Button>
              )}
            </CopyButton>
          </Stack>
        ) : (
          <Stack>
            <TextInput
              label="Token name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              required
            />
            <Group justify="flex-end">
              <Button
                onClick={onMint}
                loading={mint.isPending}
                disabled={name.trim().length < 1}
              >
                Mint
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function TokenTable({ agent }: { agent: Agent }) {
  const revoke = useRevokeAgentToken();
  if (agent.tokens.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No tokens yet.
      </Text>
    );
  }
  return (
    <Table>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Name</Table.Th>
          <Table.Th>Token</Table.Th>
          <Table.Th>Created</Table.Th>
          <Table.Th>Last used</Table.Th>
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {agent.tokens.map((token) => (
          <Table.Tr key={token.id}>
            <Table.Td>{token.name}</Table.Td>
            <Table.Td>
              <Code>{token.tokenPrefix}…</Code>
            </Table.Td>
            <Table.Td>{formatDate(token.createdAt)}</Table.Td>
            <Table.Td>{formatDate(token.lastUsedAt)}</Table.Td>
            <Table.Td>
              {token.revokedAt ? (
                <Badge color="gray">revoked</Badge>
              ) : (
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  loading={revoke.isPending}
                  onClick={() => {
                    if (window.confirm(`Revoke token "${token.name}"?`)) {
                      revoke.mutate(token.id);
                    }
                  }}
                >
                  Revoke
                </Button>
              )}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export default function AgentsSettingsPage() {
  const { isAdmin } = useUserRole();
  const { data: agents, isLoading } = useAgentsQuery();

  if (!isAdmin) {
    return <Text>Only workspace admins can manage agents.</Text>;
  }

  return (
    <>
      <DocumentTitle title="Agents" />
      <SettingsTitle title="Agents" />
      <Text size="sm" c="dimmed" mb="md">
        MCP agents are accounts that sign in only with a token. Each one writes
        in its own space and reads only the spaces it is added to as a member.
      </Text>
      <Group my="md" justify="flex-end">
        <CreateAgentModal />
      </Group>
      {isLoading && <Text>Loading…</Text>}
      <Stack gap="xl">
        {agents?.map((agent) => (
          <Stack key={agent.userId} gap="xs">
            <Group justify="space-between">
              <div>
                <Text fw={600}>
                  {agent.name}{" "}
                  {agent.deactivatedAt && (
                    <Badge color="gray">deactivated</Badge>
                  )}
                </Text>
                <Text size="sm" c="dimmed">
                  {agent.email} · space{" "}
                  {agent.spaceSlug ? (
                    <a href={`/s/${agent.spaceSlug}`}>{agent.spaceName}</a>
                  ) : (
                    "—"
                  )}
                </Text>
              </div>
              <MintTokenButton agent={agent} />
            </Group>
            <TokenTable agent={agent} />
          </Stack>
        ))}
        {agents?.length === 0 && <Text c="dimmed">No agents yet.</Text>}
      </Stack>
    </>
  );
}
