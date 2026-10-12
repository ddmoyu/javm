import { ActionIcon, Avatar, Button, Group, Text, Title } from "@mantine/core";
import { Icon } from "../../components/icons";
import type { OnlineProfile } from "../../services/catalog/onlineWorks";

const field = (profile: OnlineProfile | undefined, label: string) =>
  profile?.fields.find((entry) => entry.label === label)?.value;
const centimeters = (value: string | undefined) => value?.replace(/\s*cm$/i, "");

// 来源页档案行：生日、身高、罩杯、三围合并为一项，其余按原顺序附在后面。
function profileFacts(profile: OnlineProfile | undefined) {
  const facts: string[] = [];
  const birthday = field(profile, "生日");
  const height = field(profile, "身高");
  const cup = field(profile, "罩杯");
  const sizes = ["胸围", "腰围", "臀围"].map((label) => centimeters(field(profile, label)));
  if (birthday) facts.push(`生日 ${birthday}`);
  if (height) facts.push(`身高 ${/\d$/.test(height) ? `${height}cm` : height}`);
  if (cup) facts.push(`罩杯 ${cup}`);
  if (sizes.some(Boolean)) facts.push(`三围 ${sizes.map((value) => value || "?").join(" / ")}`);
  const birthplace = field(profile, "出生地");
  if (birthplace) facts.push(`出生地 ${birthplace}`);
  return facts;
}

export function WorksProfile({
  name,
  actor,
  portrait,
  profile,
  total,
  local,
  missing,
  loading,
  onRefresh,
  onCancel,
  favorite,
  favoriteBusy,
  onToggleFavorite,
}: {
  name: string;
  actor: boolean;
  portrait?: string;
  profile?: OnlineProfile;
  total?: number;
  local: number | null;
  missing?: number;
  loading: boolean;
  onRefresh?: () => void;
  onCancel?: () => void;
  favorite: boolean | null;
  favoriteBusy: boolean;
  onToggleFavorite?: () => void;
}) {
  const facts = profileFacts(profile);
  const sourceName = profile?.name && profile.name !== name ? profile.name : "";
  const counts = [
    total === undefined ? "全集数量未知" : `全集 ${total.toLocaleString()} 部`,
    local === null ? "本地 —" : `本地 ${local.toLocaleString()}`,
    ...(missing === undefined ? [] : [`缺失 ${missing.toLocaleString()}`]),
  ];
  return (
    <section className="works-profile" aria-label={`${name} 档案`}>
      {actor && (
        <Avatar
          className="works-profile-avatar"
          size={96}
          radius="md"
          src={profile?.avatarUrl ?? portrait}
          imageProps={{ loading: "lazy", decoding: "async", referrerPolicy: "no-referrer" }}
          alt=""
        >
          <Icon name="user" size={34} />
        </Avatar>
      )}
      <div className="works-profile-body">
        <Group gap="xs" align="baseline" wrap="wrap">
          <Title order={3} fz={20}>
            {name}
          </Title>
          {sourceName && (
            <Text size="sm" c="dimmed">
              {sourceName}
            </Text>
          )}
        </Group>
        {!!facts.length && (
          <Text size="sm" c="dimmed" className="works-profile-facts">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </Text>
        )}
        <Text size="sm" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
          {counts.join(" · ")}
        </Text>
        <Group gap="xs" mt={4}>
          {onRefresh && (
            <Button
              size="xs"
              variant="default"
              leftSection={loading ? undefined : <Icon name="download" size={14} />}
              loading={loading}
              loaderProps={{ type: "dots" }}
              onClick={onRefresh}
            >
              重新抓取
            </Button>
          )}
          {loading && onCancel && (
            <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
              停止
            </Button>
          )}
          {onToggleFavorite && (
            <ActionIcon
              variant="subtle"
              color={favorite ? "champagne" : "gray"}
              aria-label={favorite ? `取消收藏 ${name}` : `收藏 ${name}`}
              aria-pressed={!!favorite}
              loading={favoriteBusy}
              disabled={favorite === null}
              onClick={onToggleFavorite}
            >
              <Icon name="star" size={18} filled={!!favorite} />
            </ActionIcon>
          )}
        </Group>
      </div>
    </section>
  );
}
