import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Group,
  MultiSelect,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { describePattern, firstInvalidRule } from "./pattern";
import {
  SignupRule,
  SignupRulesState,
  SpaceGrantRole,
  useSaveSignupRules,
  useSignupRulesQuery,
} from "./signup-rules-api";

const ROLES: SpaceGrantRole[] = ["reader", "writer", "admin"];

/** One card of the form. `key` is local only and never sent. */
type RuleRow = SignupRule & { key: string };

let rowSequence = 0;
const newRow = (rule: Partial<SignupRule> = {}): RuleRow => ({
  key: `rule-${rowSequence++}`,
  pattern: "",
  spaceIds: [],
  spaceRole: "writer",
  ...rule,
});

function toRows(state: SignupRulesState): RuleRow[] {
  return state.rules.map((r) =>
    newRow({
      id: r.id,
      pattern: r.pattern,
      spaceIds: r.spaceIds,
      spaceRole: ROLES.includes(r.spaceRole) ? r.spaceRole : "reader",
    }),
  );
}

function PatternPreview({ pattern }: { pattern: string }) {
  const { t } = useTranslation("droneaid");
  const d = describePattern(pattern);
  if ("problem" in d) {
    if (d.problem === "empty") return null;
    return (
      <Text size="sm" c="red" data-testid="signup-rule-preview">
        {t(`signupRules.problem.${d.problem}`)}
      </Text>
    );
  }
  return (
    <Text size="sm" c="dimmed" data-testid="signup-rule-preview">
      {t(`signupRules.preview.${d.kind}`, { value: d.value })}
    </Text>
  );
}

interface RuleCardProps {
  row: RuleRow;
  index: number;
  spaceOptions: { value: string; label: string }[];
  showErrors: boolean;
  onChange: (row: RuleRow) => void;
  onRemove: () => void;
}

function RuleCard(props: RuleCardProps) {
  const { row, index, spaceOptions, showErrors, onChange, onRemove } = props;
  const { t } = useTranslation("droneaid");
  const d = describePattern(row.pattern);
  const patternError =
    showErrors && "problem" in d ? t(`signupRules.problem.${d.problem}`) : undefined;

  // Spaces deleted since the rule was saved stay selected and visible.
  const data = useMemo(() => {
    const known = new Set(spaceOptions.map((o) => o.value));
    const missing = row.spaceIds
      .filter((id) => !known.has(id))
      .map((id) => ({
        value: id,
        label: `${t("signupRules.missingSpace")} (${id.slice(0, 8)})`,
      }));
    return [...spaceOptions, ...missing];
  }, [spaceOptions, row.spaceIds, t]);

  return (
    <Card withBorder padding="md" data-testid={`signup-rule-${index}`}>
      <Stack gap="xs">
        <TextInput
          label={t("signupRules.pattern")}
          placeholder={t("signupRules.patternPlaceholder")}
          value={row.pattern}
          error={patternError}
          onChange={(e) => onChange({ ...row, pattern: e.currentTarget.value })}
          data-testid="signup-rule-pattern"
        />
        {!patternError && <PatternPreview pattern={row.pattern} />}
        <Group grow align="flex-start">
          <MultiSelect
            label={t("signupRules.spaces")}
            placeholder={t("signupRules.spacesPlaceholder")}
            data={data}
            value={row.spaceIds}
            onChange={(spaceIds) => onChange({ ...row, spaceIds })}
            searchable
            clearable
            data-testid="signup-rule-spaces"
          />
          <Select
            label={t("signupRules.role")}
            data={ROLES.map((r) => ({
              value: r,
              label: t(`signupRules.roles.${r}`),
            }))}
            value={row.spaceRole}
            onChange={(v) =>
              v && onChange({ ...row, spaceRole: v as SpaceGrantRole })
            }
            allowDeselect={false}
            data-testid="signup-rule-role"
          />
        </Group>
        <Group justify="flex-end">
          <Button size="xs" variant="subtle" color="red" onClick={onRemove}>
            {t("signupRules.removeRule")}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

export default function SignupRulesPage() {
  const { t } = useTranslation("droneaid");
  const { isAdmin } = useUserRole();
  const { data, isLoading } = useSignupRulesQuery();
  const save = useSaveSignupRules();
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [allowGoogle, setAllowGoogle] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (!data) return;
    setRows(toRows(data));
    setAllowGoogle(data.allowGoogleSignup);
  }, [data]);

  const spaceOptions = useMemo(
    () =>
      (data?.spaces ?? []).map((s) => ({
        value: s.id,
        label: s.name || s.slug,
      })),
    [data],
  );

  if (!isAdmin) {
    return <Text>{t("signupRules.adminOnly")}</Text>;
  }

  const invalidIndex = firstInvalidRule(rows);
  const update = (key: string, next: RuleRow) =>
    setRows((current) => current.map((r) => (r.key === key ? next : r)));

  const onSave = async () => {
    if (invalidIndex !== -1) {
      setShowErrors(true);
      return;
    }
    await save.mutateAsync({
      allowGoogleSignup: allowGoogle,
      rules: rows.map(({ key: _key, ...rule }) => ({
        ...rule,
        pattern: rule.pattern.trim(),
      })),
    });
    setShowErrors(false);
    notifications.show({ message: t("signupRules.saved") });
  };

  return (
    <>
      <DocumentTitle title={t("signupRules.title")} />
      <SettingsTitle title={t("signupRules.title")} />
      <Text size="sm" c="dimmed" mb="md">
        {t("signupRules.intro")}
      </Text>

      {data && !data.googleConfigured && (
        <Alert color="yellow" mb="md">
          {t("signupRules.googleNotConfigured")}
        </Alert>
      )}

      <Switch
        mb="lg"
        label={t("signupRules.allowGoogle")}
        description={t("signupRules.allowGoogleHint")}
        checked={allowGoogle}
        onChange={(e) => setAllowGoogle(e.currentTarget.checked)}
        data-testid="signup-rules-allow-google"
      />

      {isLoading && <Text>…</Text>}
      <Stack gap="md">
        {rows.map((row, index) => (
          <RuleCard
            key={row.key}
            row={row}
            index={index}
            spaceOptions={spaceOptions}
            showErrors={showErrors}
            onChange={(next) => update(row.key, next)}
            onRemove={() =>
              setRows((current) => current.filter((r) => r.key !== row.key))
            }
          />
        ))}
        {data && rows.length === 0 && (
          <Text c="dimmed">{t("signupRules.empty")}</Text>
        )}
      </Stack>

      {showErrors && invalidIndex !== -1 && (
        <Alert color="red" mt="md" data-testid="signup-rules-invalid">
          {t("signupRules.invalid")}
        </Alert>
      )}

      <Group mt="lg" justify="space-between">
        <Button
          variant="default"
          onClick={() => setRows((current) => [...current, newRow()])}
          disabled={!data}
          data-testid="signup-rules-add"
        >
          {t("signupRules.addRule")}
        </Button>
        <Button
          onClick={onSave}
          loading={save.isPending}
          disabled={!data}
          data-testid="signup-rules-save"
        >
          {t("signupRules.save")}
        </Button>
      </Group>
    </>
  );
}
