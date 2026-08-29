# tests/fixtures/live2d

P3-00C Live2D 测试夹具。

- `fake-model/` — 最小合法模型目录：一个 `.model3.json` 入口 + moc3/纹理/physics/表情/动作存根。
  供 P3A-09（模型发现）与 P3A-10（验证器）测试使用；文件内容是占位符，不是真实 Cubism 二进制。
- `fake-model/items_pinned_to_model.json` — airi `items_pinned_to_model` 补丁同名诱饵：
  模型发现**绝不**允许把它误识别为模型入口（P3A-09 验收红线的反例夹具）。
