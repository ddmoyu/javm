//! NFO 文件解析器
//!
//! 使用 quick_xml 事件驱动解析 Kodi/Emby/Jellyfin 兼容的 NFO 文件，
//! 提取视频元数据（标题、演员、标签等）。

use quick_xml::events::Event;
use quick_xml::Reader;
use std::path::Path;

/// 从 NFO 文件中解析出的元数据
pub struct NfoData {
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub sort_title: Option<String>,
    pub plot: Option<String>,
    pub outline: Option<String>,
    pub original_plot: Option<String>,
    pub tagline: Option<String>,
    pub local_id: Option<String>,
    pub studio: Option<String>,
    pub maker: Option<String>,
    pub publisher: Option<String>,
    pub label: Option<String>,
    pub set_name: Option<String>,
    pub director: Option<String>,
    pub premiered: Option<String>,
    pub release_date: Option<String>,
    pub mpaa: Option<String>,
    pub custom_rating: Option<String>,
    pub country_code: Option<String>,
    pub rating: Option<f64>,
    pub critic_rating: Option<i32>,
    pub poster_url: Option<String>,
    pub remote_cover_url: Option<String>,
    pub thumb_urls: Vec<String>,
    pub actor_names: Vec<String>,
    pub tag_names: Vec<String>,
    pub genre_names: Vec<String>,
}

/// 使用 quick_xml 解析 NFO 文件内容，返回结构化元数据
///
/// `duration` 参数为可变引用：如果当前时长为空或 0，且 NFO 中包含 runtime，则回填时长值
pub fn parse_nfo(nfo_path: &Path, duration: &mut Option<i32>) -> Option<NfoData> {
    let content = match std::fs::read(nfo_path) {
        Ok(bytes) => {
            // 跳过 UTF-8 BOM（如果存在）
            if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                String::from_utf8_lossy(&bytes[3..]).to_string()
            } else {
                String::from_utf8_lossy(&bytes).to_string()
            }
        }
        Err(e) => {
            log::error!(
                "[nfo_parser] event=read_failed path={} error={}",
                nfo_path.display(),
                e
            );
            return None;
        }
    };

    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(true);

    let mut title: Option<String> = None;
    let mut original_title: Option<String> = None;
    let mut sort_title: Option<String> = None;
    let mut plot: Option<String> = None;
    let mut outline: Option<String> = None;
    let mut original_plot: Option<String> = None;
    let mut tagline: Option<String> = None;
    let mut local_id: Option<String> = None;
    let mut studio: Option<String> = None;
    let mut maker: Option<String> = None;
    let mut publisher: Option<String> = None;
    let mut label: Option<String> = None;
    let mut set_name: Option<String> = None;
    let mut director: Option<String> = None;
    let mut premiered: Option<String> = None;
    let mut release_date: Option<String> = None;
    let mut rating: Option<f64> = None;
    let mut critic_rating: Option<i32> = None;
    let mut mpaa: Option<String> = None;
    let mut custom_rating: Option<String> = None;
    let mut country_code: Option<String> = None;
    let mut poster_url: Option<String> = None;
    let mut remote_cover_url: Option<String> = None;
    let mut thumb_urls: Vec<String> = Vec::new();
    let mut actor_names: Vec<String> = Vec::new();
    let mut tag_names: Vec<String> = Vec::new();
    let mut genre_names: Vec<String> = Vec::new();

    // 当前标签名，用于跟踪嵌套（主要是 <actor><name>）
    let mut current_tag: Option<String> = None;
    let mut in_actor = false;
    let mut in_set = false;
    let mut current_thumb_aspect: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                match tag.as_str() {
                    "actor" => {
                        in_actor = true;
                        current_tag = None;
                    }
                    "set" => {
                        in_set = true;
                        current_tag = None;
                    }
                    "thumb" => {
                        current_thumb_aspect = e
                            .attributes()
                            .flatten()
                            .find(|attr| attr.key.as_ref() == b"aspect")
                            .and_then(|attr| attr.decode_and_unescape_value(reader.decoder()).ok())
                            .map(|value| value.to_string().to_ascii_lowercase());
                        current_tag = Some(tag);
                    }
                    _ => {
                        current_tag = Some(tag);
                    }
                }
            }
            Ok(Event::Text(ref e)) => {
                if let Some(ref tag) = current_tag {
                    let text = match e.xml10_content() {
                        Ok(cow) => cow.trim().to_string(),
                        Err(_) => continue,
                    };
                    if text.is_empty() {
                        continue;
                    }
                    match tag.as_str() {
                        "title" if !in_actor && title.is_none() => {
                            title = Some(text);
                        }
                        "originaltitle" if original_title.is_none() => {
                            original_title = Some(text);
                        }
                        "sorttitle" if sort_title.is_none() => {
                            sort_title = Some(text);
                        }
                        "plot" if plot.is_none() => {
                            plot = Some(text);
                        }
                        "outline" if outline.is_none() => {
                            outline = Some(text);
                        }
                        "originalplot" if original_plot.is_none() => {
                            original_plot = Some(text);
                        }
                        "tagline" if tagline.is_none() => {
                            tagline = Some(text);
                        }
                        // 番号从 uniqueid 标签获取
                        "uniqueid" | "num" => {
                            local_id = Some(text);
                        }
                        "studio" if studio.is_none() => {
                            studio = Some(text);
                        }
                        "maker" if maker.is_none() => {
                            maker = Some(text);
                        }
                        "publisher" if publisher.is_none() => {
                            publisher = Some(text);
                        }
                        "label" if label.is_none() => {
                            label = Some(text);
                        }
                        "premiered" if premiered.is_none() => {
                            premiered = Some(text);
                        }
                        "releasedate" | "release" if release_date.is_none() => {
                            release_date = Some(text);
                        }
                        "director" if !in_actor && director.is_none() => {
                            director = Some(text);
                        }
                        "mpaa" if mpaa.is_none() => {
                            mpaa = Some(text);
                        }
                        "customrating" if custom_rating.is_none() => {
                            custom_rating = Some(text);
                        }
                        "countrycode" if country_code.is_none() => {
                            country_code = Some(text);
                        }
                        "rating" if rating.is_none() => {
                            if let Ok(v) = text.parse::<f64>() {
                                rating = Some(v);
                            }
                        }
                        "criticrating" if critic_rating.is_none() => {
                            if let Ok(v) = text.parse::<i32>() {
                                critic_rating = Some(v);
                            }
                        }
                        "runtime" => {
                            if let Ok(minutes) = text.parse::<i32>() {
                                if duration.unwrap_or(0) <= 0 {
                                    *duration = Some(minutes * 60);
                                }
                            }
                        }
                        "poster" if poster_url.is_none() => {
                            poster_url = Some(text);
                        }
                        "cover" if remote_cover_url.is_none() => {
                            remote_cover_url = Some(text);
                        }
                        "thumb" => {
                            if current_thumb_aspect.as_deref() == Some("poster") {
                                if remote_cover_url.is_none() {
                                    remote_cover_url = Some(text);
                                }
                            } else {
                                thumb_urls.push(text);
                            }
                        }
                        "name" if in_actor => {
                            actor_names.push(text);
                        }
                        "name" if in_set && set_name.is_none() => {
                            set_name = Some(text);
                        }
                        "tag" => {
                            tag_names.push(text);
                        }
                        "genre" => {
                            genre_names.push(text);
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag == "actor" {
                    in_actor = false;
                }
                if tag == "set" {
                    in_set = false;
                }
                if tag == "thumb" {
                    current_thumb_aspect = None;
                }
                current_tag = None;
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                log::error!(
                    "[nfo_parser] event=parse_failed path={} error={}",
                    nfo_path.display(),
                    e
                );
                return None;
            }
            _ => {}
        }
    }

    if premiered.is_none() {
        premiered = release_date.clone();
    }
    if release_date.is_none() {
        release_date = premiered.clone();
    }
    if outline.is_none() {
        outline = plot.clone();
    }
    if original_plot.is_none() {
        original_plot = plot.clone();
    }
    if poster_url.is_none() {
        poster_url = remote_cover_url.clone();
    }

    Some(NfoData {
        title,
        original_title,
        sort_title,
        plot,
        outline,
        original_plot,
        tagline,
        local_id,
        studio,
        maker,
        publisher,
        label,
        set_name,
        director,
        premiered,
        release_date,
        mpaa,
        custom_rating,
        country_code,
        rating,
        critic_rating,
        poster_url,
        remote_cover_url,
        thumb_urls,
        actor_names,
        tag_names,
        genre_names,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_nfo;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_temp_nfo(content: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("javm-nfo-parser-{}.nfo", unique));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn parse_nfo_should_keep_existing_real_duration() {
        let path = write_temp_nfo("<movie><runtime>120</runtime></movie>");
        let mut duration = Some(5_400);

        let _ = parse_nfo(&path, &mut duration);

        assert_eq!(duration, Some(5_400));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn parse_nfo_should_fill_duration_when_missing() {
        let path = write_temp_nfo("<movie><runtime>120</runtime></movie>");
        let mut duration = None;

        let _ = parse_nfo(&path, &mut duration);

        assert_eq!(duration, Some(7_200));
        let _ = std::fs::remove_file(path);
    }
}
