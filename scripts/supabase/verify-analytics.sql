-- 部署后的只读回读；只返回结构、权限、布尔检查与总量，不返回用户明细。
SELECT '01 原表快照数' AS check_name, count(*)::text AS result FROM public.app_daily_stats
UNION ALL SELECT '02 按日历史数', count(*)::text FROM public.app_daily_stats_history
UNION ALL SELECT '03 现有快照全部归档', (NOT EXISTS (
    SELECT 1 FROM public.app_daily_stats s LEFT JOIN public.app_daily_stats_history h
    ON h.user_id=s.user_id AND h.stat_date=s.stat_date WHERE h.user_id IS NULL
))::text
UNION ALL SELECT '04 历史唯一键', pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='public.app_daily_stats_history'::regclass AND contype='p'
UNION ALL SELECT '05 归档触发器启用', (tgenabled='O')::text FROM pg_trigger
    WHERE tgrelid='public.app_daily_stats'::regclass AND tgname='javm_archive_daily_stats'
UNION ALL SELECT '06 历史 RLS 开启', relrowsecurity::text FROM pg_class
    WHERE oid='public.app_daily_stats_history'::regclass
UNION ALL SELECT '07 匿名无历史访问权限', (NOT has_table_privilege('anon','public.app_daily_stats_history','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))::text
UNION ALL SELECT '08 匿名无原表多余权限', (NOT has_table_privilege('anon','public.app_daily_stats','DELETE,TRUNCATE,REFERENCES,TRIGGER'))::text
UNION ALL SELECT '09 匿名仍有上报权限', (has_table_privilege('anon','public.app_daily_stats','INSERT') AND has_table_privilege('anon','public.app_daily_stats','UPDATE') AND has_table_privilege('anon','public.app_daily_stats','SELECT'))::text
UNION ALL SELECT '10 函数禁止客户端调用', (NOT has_function_privilege('anon','public.javm_archive_daily_stats()','EXECUTE'))::text
ORDER BY check_name;

-- 单独运行下面的只读事务验证 RLS 请求方法；不插入或修改任何统计行。
BEGIN READ ONLY;
SET LOCAL ROLE anon;
DO $verify$
BEGIN
    PERFORM set_config('request.method','GET',true);
    IF EXISTS (SELECT 1 FROM public.app_daily_stats) THEN RAISE EXCEPTION '匿名 GET 仍能读取统计'; END IF;
    PERFORM set_config('request.method','HEAD',true);
    IF EXISTS (SELECT 1 FROM public.app_daily_stats) THEN RAISE EXCEPTION '匿名 HEAD 仍能读取统计'; END IF;
    PERFORM set_config('request.method','POST',true);
    IF NOT EXISTS (SELECT 1 FROM public.app_daily_stats) THEN RAISE EXCEPTION 'POST upsert 无法读取原有行'; END IF;
END;
$verify$;
ROLLBACK;
