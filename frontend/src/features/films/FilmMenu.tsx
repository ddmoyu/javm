import { Menu } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";

export function FilmMenuItems({ film, remove }: { film: Film; remove: () => void }) {
  const { play, openFilm, toggleFavorite, scrape, notice } = useWorkspace();
  return (
    <>
      <Menu.Label>{film.code}</Menu.Label>
      <Menu.Item
        disabled={!film.files?.some((file) => file.kind === "video" && !file.missing)}
        leftSection={<Icon name="play" />}
        onClick={() => play(film)}
      >
        播放影片
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="list" />} onClick={() => openFilm(film)}>
        影片详情
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="image" />} onClick={() => openFilm(film, "screenshots")}>
        查看截图
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="link" />} onClick={() => openFilm(film, "links")}>
        资源链接
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item leftSection={<Icon name="heart" />} onClick={() => toggleFavorite(film)}>
        {film.favorite ? "取消收藏" : "加入收藏"}
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="edit" />} onClick={() => openFilm(film, "edit")}>
        编辑资料
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="scan" />} onClick={() => scrape(film)}>
        补全资料
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="folder" />} onClick={() => openFilm(film, "files")}>
        查看文件
      </Menu.Item>
      <Menu.Item
        leftSection={<Icon name="link" />}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(film.code);
            notice("番号已复制");
          } catch {
            notice("复制失败，请重试");
          }
        }}
      >
        复制番号
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        color="red"
        disabled={film.files?.some((file) => file.kind === "video")}
        leftSection={<Icon name="trash" />}
        onClick={remove}
      >
        从片库移除
      </Menu.Item>
    </>
  );
}
