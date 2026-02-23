-- 为 tg_file_id 添加索引，加速 Telegram 上传去重查询
-- 没有此索引时，按 tg_file_id 查重需要全表扫描

CREATE INDEX IF NOT EXISTS idx_files_tg_file_id ON files(tg_file_id);
