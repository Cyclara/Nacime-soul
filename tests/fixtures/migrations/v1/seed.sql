-- v1 迁移测试夹具：代表一个已发布 v1 版本、含真实数据的记忆库。
-- 当 Phase 3+ 新增 002 迁移时，本夹具用于验证"旧版数据跑全链→validate 全过"。
-- 生成方式：先用 MigrationRunner 建 v1 schema，再 exec 本文件。

INSERT INTO sessions (id, created_at, updated_at, title)
  VALUES ('sess_v1_1', 1710000000000, 1710000600000, '初次对话');

INSERT INTO messages (id, session_id, seq, role, content, status, created_at) VALUES
  ('msg_1', 'sess_v1_1', 0, 'user',      '你好，我叫小明',       'complete', 1710000000000),
  ('msg_2', 'sess_v1_1', 1, 'assistant', '你好小明，很高兴认识你', 'complete', 1710000001000);

INSERT INTO l2_memories (id, content, confidence, sync_status, lifecycle_state, type, importance)
  VALUES ('l2_1710000002000_a1', '用户的名字是小明', 0.95, 'synced', 'active', 'stable', 8);

INSERT INTO conflict_log (id, ts, new_memory_id, existing_memory_id, score, band, resolution)
  VALUES ('cf_1', 1710000003000, 'l2_1710000002000_a1', NULL, 20, 'idle', 'none');

INSERT INTO growth_events (id, ts, type, payload)
  VALUES ('ge_1', 1710000002000, 'l0.filled', '{"field":"preferredName"}');

INSERT INTO growth_milestones (id, ts) VALUES ('ms.name', 1710000002000);
