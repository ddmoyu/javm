import { Menu } from "@mantine/core";
import type { Film } from "./data";
import { usePrototype } from "./state";
import { Icon } from "./visuals";

export function FilmMenuItems({ film, remove }: { film: Film; remove: () => void }) {
  const { play, openFilm, setFilms, scrape, notice } = usePrototype();
  return (
    <>
      <Menu.Label>{film.code}</Menu.Label>
      <Menu.Item leftSection={<Icon name="play" />} onClick={() => play(film)}>
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
      <Menu.Item
        leftSection={<Icon name="heart" />}
        onClick={() =>
          setFilms((previous) =>
            previous.map((item) =>
              item.id === film.id ? { ...item, favorite: !item.favorite } : item,
            ),
          )
        }
      >
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
      <Menu.Item color="red" leftSection={<Icon name="trash" />} onClick={remove}>
        从片库移除
      </Menu.Item>
    </>
  );
}
