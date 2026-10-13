import { Menu } from "@mantine/core";
import type { Film } from "../../contracts/media";
import { useWorkspace } from "../../app/state";
import { Icon } from "../../components/icons";
import { openMediaDirectory } from "../../platform/neutralino/directoryPicker";
import { parentDirectory } from "../../services/library/maintenanceRules";
import { libraryError } from "../../services/library/LibraryService";

export function FilmMenuItems({ film, deleteVideo }: { film: Film; deleteVideo: () => void }) {
  const { play, openFilm, toggleFavorite, library, notice, runtime } = useWorkspace();
  const videos = film.files?.filter((file) => file.kind === "video") ?? [];
  const localFile =
    videos.find((file) => !file.missing) ??
    videos[0] ??
    film.files?.find((file) => file.kind === "metadata");
  const directory = localFile ? parentDirectory(localFile.path) : film.metadata?.directory;
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
      <Menu.Divider />
      <Menu.Item leftSection={<Icon name="heart" />} onClick={() => toggleFavorite(film)}>
        {film.favorite ? "取消收藏" : "加入收藏"}
      </Menu.Item>
      <Menu.Item leftSection={<Icon name="edit" />} onClick={() => openFilm(film, "edit")}>
        编辑资料
      </Menu.Item>
      <Menu.Item
        leftSection={<Icon name="folder" />}
        disabled={runtime !== "desktop" || !directory}
        title={directory}
        onClick={async () => {
          if (!directory) return;
          try {
            await openMediaDirectory(directory);
          } catch (error) {
            notice(libraryError(error));
          }
        }}
      >
        打开目录
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        color="red"
        disabled={!library.maintenance || !videos.some((file) => file.id && file.path)}
        leftSection={<Icon name="trash" />}
        onClick={deleteVideo}
      >
        删除视频
      </Menu.Item>
    </>
  );
}
