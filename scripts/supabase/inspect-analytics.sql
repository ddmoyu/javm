-- 只读预检，不返回匿名身份、统计明细或任何媒体数据。
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'app_daily_stats'
ORDER BY ordinal_position;

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'app_daily_stats';

SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid = 'public.app_daily_stats'::regclass;

SELECT policyname, roles, cmd, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'app_daily_stats';

SELECT grantee, privilege_type FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'app_daily_stats';

SELECT tgname, pg_get_triggerdef(oid) AS definition
FROM pg_trigger WHERE tgrelid = 'public.app_daily_stats'::regclass AND NOT tgisinternal;

SELECT to_regclass('public.app_daily_stats_history') AS existing_history,
       to_regprocedure('public.javm_archive_daily_stats()') AS existing_function;
