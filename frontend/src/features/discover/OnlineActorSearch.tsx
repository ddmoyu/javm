import { useEffect, useSyncExternalStore } from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import type { OnlineActorSearchService } from "../../services/catalog/OnlineActorSearchService";
import type { AvwikiEntity } from "../../services/catalog/avwikiWorks";
import { publicMessage } from "../../services/publicMessage";
export function OnlineActorSearch({
  service,
  query,
  active,
  select,
}: {
  service: OnlineActorSearchService;
  query: string;
  active: boolean;
  select: (entity: AvwikiEntity) => void;
}) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot);
  useEffect(() => {
    if (active && query) {
      const previous = service.getSnapshot();
      service.search(query, previous.query === query ? previous.page : 1);
    }
    return () => service.cancel();
  }, [service, query, active]);
  const current = state.query === query;
  return (
    <Stack gap="sm" my="md">
      <Text size="xs" c="dimmed">
        在线查找演员 · 不受现有名单限制 · 按网站搜索结果顺序显示
      </Text>
      {!state.available && <Alert>请在桌面版使用在线搜索。</Alert>}
      {state.loading && (
        <Group component="output" aria-live="polite">
          <Loader size="xs" />
          <Text size="sm">正在查询 JavBus…</Text>
          <Button size="compact-xs" variant="subtle" onClick={service.cancel}>
            取消
          </Button>
        </Group>
      )}
      {current &&
        Object.entries(state.errors).map(([lane, error]) => (
          <Alert key={lane} color="orange" role="alert">
            {lane === "censored" ? "主分区" : "另一分区"}：{publicMessage(error)}
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={state.loading}
              onClick={service.retry}
            >
              重试
            </Button>
          </Alert>
        ))}
      {current && (
        <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }}>
          {state.items.map((entity) => (
            <Paper key={entity.id} withBorder p="sm" radius="md">
              <UnstyledButton w="100%" data-name={entity.name} onClick={() => select(entity)}>
                <Text size="sm" fw={500}>
                  {entity.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {entity.url.includes("/uncensored/") ? "另一分区" : "主分区"} · 查看作品
                </Text>
              </UnstyledButton>
            </Paper>
          ))}
        </SimpleGrid>
      )}
      {current &&
        !!query &&
        state.ready &&
        !state.loading &&
        !state.items.length &&
        !Object.keys(state.errors).length && (
          <Text size="sm">未找到演员，可以尝试原名或其他别名。</Text>
        )}
      {current && !!query && !state.loading && !state.ready && (
        <Button variant="subtle" onClick={service.retry}>
          继续搜索
        </Button>
      )}
      {current && (state.page > 1 || Object.values(state.next).some(Boolean)) && (
        <Group justify="center">
          <Button
            variant="default"
            disabled={state.loading || state.page === 1}
            onClick={() => service.search(query, state.page - 1)}
          >
            上一页
          </Button>
          <Text size="sm">第 {state.page} 页</Text>
          <Button
            variant="default"
            disabled={state.loading || !Object.values(state.next).some(Boolean)}
            onClick={() => service.search(query, state.page + 1)}
          >
            下一页
          </Button>
        </Group>
      )}
    </Stack>
  );
}
