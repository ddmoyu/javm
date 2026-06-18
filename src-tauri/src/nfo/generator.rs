use crate::resource_scrape::types::ScrapeMetadata;
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::Writer;
use std::io::Cursor;
use std::path::{Path, PathBuf};

/// NFO 文件生成器
///
/// 生成兼容 Kodi/Emby/Jellyfin 的 NFO 文件（XML 格式），
/// 带 UTF-8 BOM 以确保 Windows 下正确显示中文。
pub struct NfoGenerator;

impl NfoGenerator {
    /// 创建新的 NFO 生成器实例
    pub fn new() -> Self {
        Self
    }

    /// 根据元数据生成 NFO XML 内容
    ///
    /// # 参数
    /// * `metadata` - 视频元数据
    /// * `local_poster_path` - 本地封面文件路径（如 "poster.jpg"），可选
    ///
    /// # 返回
    /// * `Result<Vec<u8>, String>` - 带 UTF-8 BOM 的 XML 内容，或错误信息
    pub fn generate(
        &self,
        metadata: &ScrapeMetadata,
        local_poster_path: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        let mut writer = Writer::new_with_indent(Cursor::new(Vec::new()), b' ', 2);

        // 写入 XML 声明
        writer
            .write_event(Event::Decl(quick_xml::events::BytesDecl::new(
                "1.0",
                Some("UTF-8"),
                Some("yes"),
            )))
            .map_err(|e| format!("写入 XML 声明失败: {}", e))?;

        // 开始 <movie> 根标签
        writer
            .write_event(Event::Start(BytesStart::new("movie")))
            .map_err(|e| format!("写入 movie 标签失败: {}", e))?;

        // 准备字段值，对空值和异常值做防御处理
        let release_date = if metadata.premiered.trim().is_empty() {
            metadata.tagline.trim().trim_start_matches("发行日期 ").to_string()
        } else {
            metadata.premiered.trim().to_string()
        };
        let runtime_str = metadata.duration.unwrap_or(0).max(0).to_string();
        let year_str = Self::extract_year(&release_date);
        let rating_str = Self::clamp_rating(metadata.score).to_string();
        let critic_rating_str = metadata.critic_rating.unwrap_or(0).max(0).to_string();
        let title = Self::sanitize_text(&metadata.title);
        let plot = Self::sanitize_text(&metadata.plot);
        let outline = Self::sanitize_text(if metadata.outline.trim().is_empty() {
            &metadata.plot
        } else {
            &metadata.outline
        });
        let original_plot = Self::sanitize_text(if metadata.original_plot.trim().is_empty() {
            &metadata.plot
        } else {
            &metadata.original_plot
        });
        let studio = Self::sanitize_text(&metadata.studio);
        let premiered = Self::sanitize_text(&release_date);
        let local_id = Self::sanitize_text(&metadata.local_id);
        let tagline_source = if metadata.tagline.trim().is_empty() && !premiered.is_empty() {
            format!("发行日期 {}", premiered)
        } else {
            metadata.tagline.clone()
        };
        let tagline = Self::sanitize_text(&tagline_source);
        let sort_title = Self::sanitize_text(if metadata.sort_title.trim().is_empty() {
            &title
        } else {
            &metadata.sort_title
        });
        let mpaa = Self::sanitize_text(&metadata.mpaa);
        let custom_rating = Self::sanitize_text(&metadata.custom_rating);
        let country_code = Self::sanitize_text(&metadata.country_code);
        let set_name = Self::sanitize_text(&metadata.set_name);
        let maker = Self::sanitize_text(if metadata.maker.trim().is_empty() {
            &metadata.studio
        } else {
            &metadata.maker
        });
        let publisher = Self::sanitize_text(&metadata.publisher);
        let label = Self::sanitize_text(&metadata.label);
        let poster_url = Self::sanitize_text(if metadata.poster_url.trim().is_empty() {
            &metadata.cover_url
        } else {
            &metadata.poster_url
        });
        let cover_url = Self::sanitize_text(if metadata.cover_url.trim().is_empty() {
            &metadata.poster_url
        } else {
            &metadata.cover_url
        });
        // 写入基本字段
        self.write_simple_element(&mut writer, "plot", &plot)?;
        self.write_simple_element(&mut writer, "outline", &outline)?;
        self.write_simple_element(&mut writer, "originalplot", &original_plot)?;
        self.write_simple_element(&mut writer, "tagline", &tagline)?;
        self.write_simple_element(&mut writer, "releasedate", &premiered)?;
        self.write_simple_element(&mut writer, "release", &premiered)?;
        self.write_simple_element(&mut writer, "num", &local_id)?;
        self.write_simple_element(&mut writer, "title", &title)?;
        // originaltitle：优先使用 original_title，回退到 title
        let original_title = metadata
            .original_title
            .as_deref()
            .map(|s| Self::sanitize_text(s))
            .unwrap_or_else(|| title.clone());
        self.write_simple_element(&mut writer, "originaltitle", &original_title)?;
        self.write_simple_element(&mut writer, "sorttitle", &sort_title)?;
        self.write_simple_element(&mut writer, "mpaa", &mpaa)?;
        self.write_simple_element(&mut writer, "customrating", &custom_rating)?;
        self.write_simple_element(&mut writer, "countrycode", &country_code)?;
        self.write_simple_element(&mut writer, "studio", &studio)?;
        self.write_simple_element(&mut writer, "year", &year_str)?;
        self.write_simple_element(&mut writer, "premiered", &premiered)?;

        // 写入唯一标识（带属性）
        self.write_uniqueid(&mut writer, &local_id)?;

        // 写入演员列表
        for actor in &metadata.actors {
            let name = Self::sanitize_text(actor);
            if name.is_empty() {
                continue; // 跳过空演员名
            }
            writer
                .write_event(Event::Start(BytesStart::new("actor")))
                .map_err(|e| format!("写入 actor 标签失败: {}", e))?;
            self.write_simple_element(&mut writer, "name", &name)?;
            self.write_simple_element(&mut writer, "type", "Actor")?;
            writer
                .write_event(Event::End(BytesEnd::new("actor")))
                .map_err(|e| format!("关闭 actor 标签失败: {}", e))?;
        }

        // 写入导演（如有）
        let director = Self::sanitize_text(&metadata.director);
        if !director.is_empty() {
            self.write_simple_element(&mut writer, "director", &director)?;
        }

        // 写入时长和评分
        self.write_simple_element(&mut writer, "runtime", &runtime_str)?;
        self.write_simple_element(&mut writer, "rating", &rating_str)?;
        self.write_simple_element(&mut writer, "criticrating", &critic_rating_str)?;

        if !set_name.is_empty() {
            writer
                .write_event(Event::Start(BytesStart::new("set")))
                .map_err(|e| format!("写入 set 标签失败: {}", e))?;
            self.write_simple_element(&mut writer, "name", &set_name)?;
            writer
                .write_event(Event::End(BytesEnd::new("set")))
                .map_err(|e| format!("关闭 set 标签失败: {}", e))?;
        }

        self.write_simple_element(&mut writer, "maker", &maker)?;
        self.write_simple_element(&mut writer, "publisher", &publisher)?;
        self.write_simple_element(&mut writer, "label", &label)?;

        self.write_simple_element(&mut writer, "poster", &poster_url)?;
        self.write_simple_element(&mut writer, "cover", &cover_url)?;

        // 写入本地封面缩略图
        if let Some(poster_path) = local_poster_path {
            let poster_path = poster_path.trim();
            if !poster_path.is_empty() {
                self.write_thumb(&mut writer, poster_path, Some("poster"), None)?;
            }
        }

        // 写入远程封面缩略图（带预览）
        if !cover_url.is_empty() {
            self.write_thumb(&mut writer, &cover_url, Some("poster"), Some(&cover_url))?;
        }

        // 写入远程预览图
        for thumb_url in &metadata.thumbs {
            let url = Self::sanitize_text(thumb_url);
            if !url.is_empty() {
                self.write_thumb(&mut writer, &url, None, None)?;
            }
        }

        // 写入标签（分类/类型）
        for tag in &metadata.tags {
            let tag = Self::sanitize_text(tag);
            if !tag.is_empty() {
                self.write_simple_element(&mut writer, "tag", &tag)?;
            }
        }

        for genre in &metadata.genres {
            let genre = Self::sanitize_text(genre);
            if !genre.is_empty() {
                self.write_simple_element(&mut writer, "genre", &genre)?;
            }
        }

        // 关闭 </movie> 标签
        writer
            .write_event(Event::End(BytesEnd::new("movie")))
            .map_err(|e| format!("关闭 movie 标签失败: {}", e))?;

        let xml_content = writer.into_inner().into_inner();

        // 添加 UTF-8 BOM (0xEF, 0xBB, 0xBF)，确保 Windows 兼容性
        let mut content_with_bom = Vec::with_capacity(3 + xml_content.len());
        content_with_bom.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        content_with_bom.extend_from_slice(&xml_content);

        Ok(content_with_bom)
    }

    /// 保存 NFO 文件到磁盘
    ///
    /// # 参数
    /// * `metadata` - 视频元数据
    /// * `video_path` - 视频文件路径（NFO 将使用相同文件名但扩展名为 .nfo）
    /// * `local_poster_path` - 本地封面文件路径，可选
    ///
    /// # 返回
    /// * `Result<PathBuf, String>` - 保存的 NFO 文件路径，或错误信息
    ///
    /// # 示例
    /// 若 video_path 为 "/videos/ABC-123.mp4"，NFO 将保存为 "/videos/ABC-123.nfo"
    pub fn save(
        &self,
        metadata: &ScrapeMetadata,
        video_path: &Path,
        local_poster_path: Option<&str>,
    ) -> Result<PathBuf, String> {
        let content = self.generate(metadata, local_poster_path)?;
        let nfo_path = video_path.with_extension("nfo");

        // 确保父目录存在
        if let Some(parent) = nfo_path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录失败 {}: {}", parent.display(), e))?;
            }
        }

        std::fs::write(&nfo_path, content).map_err(|e| format!("写入 NFO 文件失败: {}", e))?;

        Ok(nfo_path)
    }

    /// 从日期字符串中提取年份
    ///
    /// 支持 "2024-01-15"、"2024/01/15"、"2024" 等格式，
    /// 无法解析时返回空字符串。
    fn extract_year(date_str: &str) -> String {
        let trimmed = date_str.trim();
        // 尝试用 '-' 或 '/' 分割
        let part = trimmed.split(|c| c == '-' || c == '/').next().unwrap_or("");
        // 验证是否为合法的 4 位年份
        if part.len() == 4 && part.chars().all(|c| c.is_ascii_digit()) {
            part.to_string()
        } else {
            String::new()
        }
    }

    /// 将评分限制在 0.0 ~ 10.0 范围内
    fn clamp_rating(score: Option<f64>) -> f64 {
        match score {
            Some(s) if s.is_finite() => s.clamp(0.0, 10.0),
            _ => 0.0,
        }
    }

    /// 清理文本：去除首尾空白，移除 XML 控制字符
    fn sanitize_text(text: &str) -> String {
        text.trim()
            .chars()
            .filter(|c| {
                // 过滤 XML 1.0 不允许的控制字符（保留换行、回车、制表符）
                matches!(*c, '\t' | '\n' | '\r' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}')
            })
            .collect()
    }

    /// 写入简单 XML 元素
    fn write_simple_element(
        &self,
        writer: &mut Writer<Cursor<Vec<u8>>>,
        tag: &str,
        value: &str,
    ) -> Result<(), String> {
        writer
            .write_event(Event::Start(BytesStart::new(tag)))
            .map_err(|e| format!("写入 {} 标签失败: {}", tag, e))?;
        writer
            .write_event(Event::Text(BytesText::new(value)))
            .map_err(|e| format!("写入 {} 内容失败: {}", tag, e))?;
        writer
            .write_event(Event::End(BytesEnd::new(tag)))
            .map_err(|e| format!("关闭 {} 标签失败: {}", tag, e))?;
        Ok(())
    }

    /// 写入 uniqueid 元素（带 type 和 default 属性）
    fn write_uniqueid(&self, writer: &mut Writer<Cursor<Vec<u8>>>, id: &str) -> Result<(), String> {
        let mut elem = BytesStart::new("uniqueid");
        elem.push_attribute(("type", "local"));
        elem.push_attribute(("default", "true"));

        writer
            .write_event(Event::Start(elem))
            .map_err(|e| format!("写入 uniqueid 标签失败: {}", e))?;
        writer
            .write_event(Event::Text(BytesText::new(id)))
            .map_err(|e| format!("写入 uniqueid 内容失败: {}", e))?;
        writer
            .write_event(Event::End(BytesEnd::new("uniqueid")))
            .map_err(|e| format!("关闭 uniqueid 标签失败: {}", e))?;
        Ok(())
    }

    /// 写入 thumb 元素（支持可选的 aspect 和 preview 属性）
    fn write_thumb(
        &self,
        writer: &mut Writer<Cursor<Vec<u8>>>,
        url: &str,
        aspect: Option<&str>,
        preview: Option<&str>,
    ) -> Result<(), String> {
        let mut elem = BytesStart::new("thumb");

        if let Some(aspect_val) = aspect {
            elem.push_attribute(("aspect", aspect_val));
        }
        if let Some(preview_val) = preview {
            elem.push_attribute(("preview", preview_val));
        }

        writer
            .write_event(Event::Start(elem))
            .map_err(|e| format!("写入 thumb 标签失败: {}", e))?;
        writer
            .write_event(Event::Text(BytesText::new(url)))
            .map_err(|e| format!("写入 thumb 内容失败: {}", e))?;
        writer
            .write_event(Event::End(BytesEnd::new("thumb")))
            .map_err(|e| format!("关闭 thumb 标签失败: {}", e))?;
        Ok(())
    }
}

impl Default for NfoGenerator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_metadata() -> ScrapeMetadata {
        ScrapeMetadata {
            title: "Test Video Title".to_string(),
            local_id: "ABC-123".to_string(),
            original_title: Some("Original Title".to_string()),
            plot: "Test Plot".to_string(),
            outline: "Test Outline".to_string(),
            original_plot: "Original Plot".to_string(),
            tagline: "发行日期 2024-01-15".to_string(),
            studio: "Test Studio".to_string(),
            premiered: "2024-01-15".to_string(),
            duration: Some(120),
            poster_url: "https://example.com/poster.jpg".to_string(),
            cover_url: "https://example.com/cover.jpg".to_string(),
            actors: vec!["Actor1".to_string(), "Actor2".to_string()],
            director: "Test Director".to_string(),
            score: Some(8.5),
            critic_rating: Some(88),
            sort_title: "ABC-123 Original Title".to_string(),
            mpaa: "JP-18+".to_string(),
            custom_rating: "JP-18+".to_string(),
            country_code: "JP".to_string(),
            is_uncensored: false,
            set_name: "Test Set".to_string(),
            maker: "Test Maker".to_string(),
            publisher: "Test Publisher".to_string(),
            label: "Test Label".to_string(),
            tags: vec!["Tag1".to_string(), "Tag2".to_string()],
            genres: vec!["Genre1".to_string(), "Genre2".to_string()],
            thumbs: vec![
                "https://example.com/fanart1.jpg".to_string(),
                "https://example.com/fanart2.jpg".to_string(),
            ],
        }
    }

    #[test]
    fn test_generate_nfo_content() {
        let generator = NfoGenerator::new();
        let metadata = create_test_metadata();

        let result = generator.generate(&metadata, Some("poster.jpg"));
        assert!(result.is_ok());

        let content = result.unwrap();

        // 验证 UTF-8 BOM
        assert_eq!(&content[0..3], &[0xEF, 0xBB, 0xBF]);

        let xml_str = String::from_utf8_lossy(&content[3..]);

        // 验证必要字段
        assert!(xml_str.contains("<title>Test Video Title</title>"));
        assert!(xml_str.contains("<plot>Test Plot</plot>"));
        assert!(xml_str.contains("<outline>Test Outline</outline>"));
        assert!(xml_str.contains("<originaltitle>Original Title</originaltitle>"));
        assert!(xml_str.contains("<sorttitle>ABC-123 Original Title</sorttitle>"));
        assert!(xml_str.contains("<studio>Test Studio</studio>"));
        assert!(xml_str.contains("<premiered>2024-01-15</premiered>"));
        assert!(xml_str.contains("<releasedate>2024-01-15</releasedate>"));
        assert!(xml_str.contains("<num>ABC-123</num>"));
        assert!(xml_str.contains("<runtime>120</runtime>"));
        assert!(xml_str.contains("<rating>8.5</rating>"));
        assert!(xml_str.contains("<criticrating>88</criticrating>"));
        assert!(xml_str.contains("<uniqueid type=\"local\" default=\"true\">ABC-123</uniqueid>"));
        assert!(xml_str.contains("<tag>Tag1</tag>"));
        assert!(xml_str.contains("<tag>Tag2</tag>"));
        assert!(xml_str.contains("<genre>Genre1</genre>"));
        assert!(xml_str.contains("<name>Actor1</name>"));
        assert!(xml_str.contains("<name>Actor2</name>"));
        assert!(xml_str.contains("<thumb aspect=\"poster\">poster.jpg</thumb>"));
        assert!(xml_str.contains("<poster>https://example.com/poster.jpg</poster>"));
        assert!(xml_str.contains("<cover>https://example.com/cover.jpg</cover>"));
        assert!(xml_str.contains("<thumb aspect=\"poster\" preview=\"https://example.com/cover.jpg\">https://example.com/cover.jpg</thumb>"));
        assert!(xml_str.contains("<thumb>https://example.com/fanart1.jpg</thumb>"));
        assert!(xml_str.contains("<thumb>https://example.com/fanart2.jpg</thumb>"));
    }

    #[test]
    fn test_generate_with_empty_fields() {
        let generator = NfoGenerator::new();
        let metadata = ScrapeMetadata {
            title: "Test".to_string(),
            local_id: "ABC-123".to_string(),
            original_title: None,
            plot: "".to_string(),
            outline: "".to_string(),
            original_plot: "".to_string(),
            tagline: "".to_string(),
            studio: "".to_string(),
            premiered: "2024-01-15".to_string(),
            duration: None,
            poster_url: "".to_string(),
            cover_url: "".to_string(),
            actors: vec![],
            director: "".to_string(),
            score: None,
            critic_rating: None,
            sort_title: "".to_string(),
            mpaa: "".to_string(),
            custom_rating: "".to_string(),
            country_code: "".to_string(),
            is_uncensored: false,
            set_name: "".to_string(),
            maker: "".to_string(),
            publisher: "".to_string(),
            label: "".to_string(),
            tags: vec![],
            genres: vec![],
            thumbs: vec![],
        };

        let result = generator.generate(&metadata, None);
        assert!(result.is_ok());

        let content = result.unwrap();
        let xml_str = String::from_utf8_lossy(&content[3..]);

        // 验证基本结构完整
        assert!(xml_str.contains("<movie>"));
        assert!(xml_str.contains("</movie>"));
        assert!(xml_str.contains("<title>Test</title>"));
        assert!(xml_str.contains("<runtime>0</runtime>"));
        assert!(xml_str.contains("<rating>0</rating>"));
        assert!(xml_str.contains("<uniqueid type=\"local\" default=\"true\">ABC-123</uniqueid>"));
    }

    #[test]
    fn test_save_nfo_file() {
        use std::fs;

        let generator = NfoGenerator::new();
        let metadata = create_test_metadata();

        let temp_dir = std::env::temp_dir();
        let video_path = temp_dir.join(format!("test_video_{}.mp4", std::process::id()));

        fs::write(&video_path, b"dummy video content").unwrap();

        let result = generator.save(&metadata, &video_path, Some("poster.jpg"));
        assert!(result.is_ok());

        let nfo_path = result.unwrap();
        assert_eq!(nfo_path.extension().unwrap(), "nfo");
        assert!(nfo_path.exists());

        let content = fs::read(&nfo_path).unwrap();
        assert_eq!(&content[0..3], &[0xEF, 0xBB, 0xBF]);

        let xml_str = String::from_utf8_lossy(&content[3..]);
        assert!(xml_str.contains("<title>Test Video Title</title>"));
        assert!(xml_str.contains("<uniqueid type=\"local\" default=\"true\">ABC-123</uniqueid>"));

        // 清理临时文件
        let _ = fs::remove_file(&video_path);
        let _ = fs::remove_file(&nfo_path);
    }

    #[test]
    fn test_save_nfo_file_without_local_id() {
        use std::fs;

        let generator = NfoGenerator::new();
        let mut metadata = create_test_metadata();
        metadata.local_id.clear();

        let temp_dir = std::env::temp_dir();
        let video_path = temp_dir.join(format!("test_video_no_id_{}.mp4", std::process::id()));

        fs::write(&video_path, b"dummy video content").unwrap();

        let result = generator.save(&metadata, &video_path, None);
        assert!(result.is_ok());

        let nfo_path = result.unwrap();
        assert!(nfo_path.exists());

        let content = fs::read(&nfo_path).unwrap();
        let xml_str = String::from_utf8_lossy(&content[3..]);
        assert!(xml_str.contains("<title>Test Video Title</title>"));

        let _ = fs::remove_file(&video_path);
        let _ = fs::remove_file(&nfo_path);
    }

    #[test]
    fn test_extract_year() {
        assert_eq!(NfoGenerator::extract_year("2024-01-15"), "2024");
        assert_eq!(NfoGenerator::extract_year("2024/01/15"), "2024");
        assert_eq!(NfoGenerator::extract_year("2024"), "2024");
        assert_eq!(NfoGenerator::extract_year(""), "");
        assert_eq!(NfoGenerator::extract_year("invalid"), "");
        assert_eq!(NfoGenerator::extract_year("  2024-01-15  "), "2024");
    }

    #[test]
    fn test_clamp_rating() {
        assert_eq!(NfoGenerator::clamp_rating(Some(8.5)), 8.5);
        assert_eq!(NfoGenerator::clamp_rating(Some(15.0)), 10.0);
        assert_eq!(NfoGenerator::clamp_rating(Some(-3.0)), 0.0);
        assert_eq!(NfoGenerator::clamp_rating(Some(f64::NAN)), 0.0);
        assert_eq!(NfoGenerator::clamp_rating(Some(f64::INFINITY)), 0.0);
        assert_eq!(NfoGenerator::clamp_rating(None), 0.0);
    }

    #[test]
    fn test_sanitize_text() {
        assert_eq!(NfoGenerator::sanitize_text("  hello  "), "hello");
        assert_eq!(NfoGenerator::sanitize_text("hello\x00world"), "helloworld");
        assert_eq!(NfoGenerator::sanitize_text("正常中文"), "正常中文");
        assert_eq!(NfoGenerator::sanitize_text(""), "");
    }

    #[test]
    fn test_empty_actor_skipped() {
        let generator = NfoGenerator::new();
        let metadata = ScrapeMetadata {
            title: "Test".to_string(),
            local_id: "ABC-123".to_string(),
            original_title: None,
            plot: "".to_string(),
            outline: "".to_string(),
            original_plot: "".to_string(),
            tagline: "".to_string(),
            studio: "".to_string(),
            premiered: "2024-01-15".to_string(),
            duration: None,
            poster_url: "".to_string(),
            cover_url: "".to_string(),
            actors: vec!["".to_string(), "  ".to_string(), "ValidActor".to_string()],
            director: "".to_string(),
            score: None,
            critic_rating: None,
            sort_title: "".to_string(),
            mpaa: "".to_string(),
            custom_rating: "".to_string(),
            country_code: "".to_string(),
            is_uncensored: false,
            set_name: "".to_string(),
            maker: "".to_string(),
            publisher: "".to_string(),
            label: "".to_string(),
            tags: vec!["".to_string(), "ValidTag".to_string()],
            genres: vec!["".to_string(), "ValidGenre".to_string()],
            thumbs: vec!["".to_string(), "  ".to_string()],
        };

        let result = generator.generate(&metadata, None);
        assert!(result.is_ok());

        let content = result.unwrap();
        let xml_str = String::from_utf8_lossy(&content[3..]);

        // 空演员、空标签、空剧情应被跳过
        assert!(xml_str.contains("<name>ValidActor</name>"));
        assert!(xml_str.contains("<tag>ValidTag</tag>"));
        assert!(xml_str.contains("<genre>ValidGenre</genre>"));
        // 只有一个 actor 块
        assert_eq!(xml_str.matches("<actor>").count(), 1);
        assert_eq!(xml_str.matches("<tag>").count(), 1);
        assert_eq!(xml_str.matches("<genre>").count(), 1);
    }
}
