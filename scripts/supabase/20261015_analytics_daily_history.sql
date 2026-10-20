-- 已于 2026-10-15 通过 Supabase 控制台预检真实表、触发器和权限。
-- 由数据库管理员执行；原表、原主键、原客户端请求及公开 key 不变。
-- 新对象若已存在则整笔失败，避免覆盖未知部署。失败时 ROLLBACK。
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.app_daily_stats IN SHARE ROW EXCLUSIVE MODE;

-- 从原表推导列类型，避免猜测旧表的 UUID/text 或 integer/bigint 定义。
CREATE TABLE public.app_daily_stats_history AS
SELECT user_id, stat_date, os, cpu_arch, system_language, app_version,
       play_video_count, download_video_count, app_launch_count, active_duration_seconds,
       search_designation_count, search_resource_link_count, download_video_failed_count,
       video_total_count
FROM public.app_daily_stats WITH NO DATA;

ALTER TABLE public.app_daily_stats_history
    ADD PRIMARY KEY (user_id, stat_date),
    ALTER COLUMN os SET NOT NULL,
    ALTER COLUMN cpu_arch SET NOT NULL,
    ALTER COLUMN system_language SET NOT NULL,
    ALTER COLUMN app_version SET NOT NULL,
    ALTER COLUMN play_video_count SET NOT NULL,
    ALTER COLUMN download_video_count SET NOT NULL,
    ALTER COLUMN app_launch_count SET NOT NULL,
    ALTER COLUMN active_duration_seconds SET NOT NULL,
    ALTER COLUMN search_designation_count SET NOT NULL,
    ALTER COLUMN search_resource_link_count SET NOT NULL,
    ALTER COLUMN download_video_failed_count SET NOT NULL,
    ALTER COLUMN video_total_count SET NOT NULL,
    ADD COLUMN received_at timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT javm_daily_nonnegative CHECK (
        play_video_count >= 0 AND download_video_count >= 0 AND app_launch_count >= 0
        AND active_duration_seconds >= 0 AND search_designation_count >= 0
        AND search_resource_link_count >= 0 AND download_video_failed_count >= 0
        AND video_total_count >= 0);
CREATE INDEX javm_daily_stat_date ON public.app_daily_stats_history (stat_date);
ALTER TABLE public.app_daily_stats_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_daily_stats_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.app_daily_stats_history TO service_role;

-- 只保留当前仍存在的历史数据；已被旧表覆盖的往日数据无法凭空恢复。
INSERT INTO public.app_daily_stats_history (
    user_id, stat_date, os, cpu_arch, system_language, app_version,
    play_video_count, download_video_count, app_launch_count, active_duration_seconds,
    search_designation_count, search_resource_link_count, download_video_failed_count,
    video_total_count
)
SELECT user_id, stat_date, os, cpu_arch, system_language, app_version,
       play_video_count, download_video_count, app_launch_count, active_duration_seconds,
       search_designation_count, search_resource_link_count, download_video_failed_count,
       video_total_count
FROM public.app_daily_stats;

CREATE FUNCTION public.javm_archive_daily_stats()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
    INSERT INTO public.app_daily_stats_history AS history (
        user_id, stat_date, os, cpu_arch, system_language, app_version,
        play_video_count, download_video_count, app_launch_count, active_duration_seconds,
        search_designation_count, search_resource_link_count, download_video_failed_count,
        video_total_count
    ) VALUES (
        NEW.user_id, NEW.stat_date, NEW.os, NEW.cpu_arch, NEW.system_language, NEW.app_version,
        NEW.play_video_count, NEW.download_video_count, NEW.app_launch_count, NEW.active_duration_seconds,
        NEW.search_designation_count, NEW.search_resource_link_count, NEW.download_video_failed_count,
        NEW.video_total_count
    ) ON CONFLICT (user_id, stat_date) DO UPDATE SET
        os = EXCLUDED.os,
        cpu_arch = EXCLUDED.cpu_arch,
        system_language = EXCLUDED.system_language,
        app_version = EXCLUDED.app_version,
        play_video_count = greatest(history.play_video_count, EXCLUDED.play_video_count),
        download_video_count = greatest(history.download_video_count, EXCLUDED.download_video_count),
        app_launch_count = greatest(history.app_launch_count, EXCLUDED.app_launch_count),
        active_duration_seconds = greatest(history.active_duration_seconds, EXCLUDED.active_duration_seconds),
        search_designation_count = greatest(history.search_designation_count, EXCLUDED.search_designation_count),
        search_resource_link_count = greatest(history.search_resource_link_count, EXCLUDED.search_resource_link_count),
        download_video_failed_count = greatest(history.download_video_failed_count, EXCLUDED.download_video_failed_count),
        -- 视频总数是时点值，可以减少，不参与累计最大值合并。
        video_total_count = EXCLUDED.video_total_count,
        received_at = now();
    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.javm_archive_daily_stats() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER javm_archive_daily_stats
AFTER INSERT OR UPDATE ON public.app_daily_stats
FOR EACH ROW EXECUTE FUNCTION public.javm_archive_daily_stats();

-- ON CONFLICT 仍需要 SELECT 权限和可见的旧行，按 PostgREST 请求方法限制，
-- 保留旧客户端 POST upsert，匿名 GET/HEAD 不再能读取全库统计。
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.app_daily_stats FROM anon, authenticated;
ALTER POLICY dev_select_app_daily_stats ON public.app_daily_stats
    USING (current_setting('request.method', true) = 'POST');
ALTER POLICY dev_insert_app_daily_stats ON public.app_daily_stats
    WITH CHECK (current_setting('request.method', true) = 'POST');
ALTER POLICY dev_update_app_daily_stats ON public.app_daily_stats
    USING (current_setting('request.method', true) = 'POST')
    WITH CHECK (current_setting('request.method', true) = 'POST');

COMMIT;

-- 部署后仅回读表结构、约束、策略和触发器；不要写入生产测试行。
-- 如需停用归档，单独 DROP TRIGGER javm_archive_daily_stats ON public.app_daily_stats;
-- 保留 history 表与已有统计，不删除任何原始数据。
