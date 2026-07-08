# Harmony Extension v0.3.4

### ✨ New Provider
- **Zhipu Coding Plan (Z.AI)** — separate provider using the coding plan endpoint (`api.z.ai/api/coding/paas/v4`). Reuses the same `harmony.zhipu.apiKey` with a different base URL for cost-efficient coding access.

### 🐛 Fixes
- Fixed 6 registration gaps that prevented `zhipu-coding` from appearing in the sidebar and routing correctly (sidebar dropdown, primaryDirect list, model ternary, state field, DirectPrimaryProvider type, isDirectPrimaryProvider guard)
- Tightened flow-state detection to reduce false positives:
  - Conclusion detection scans last 15% instead of 25% (prevents mid-response TODO lists from triggering)
  - Tool-prose detection skips long responses (>1200 chars) or responses with 3+ tool mentions (these are summaries, not promises)
  - Post-tool-call path uses a new `getFlowStateViolationPostTool()` that skips tool-prose detection entirely
- Added try/catch around JSON.parse in model discovery for clearer error messages when providers return non-JSON responses

### 📚 Documentation
- Updated README (EN/ZH) with Zhipu Coding Plan in architecture diagram, provider list, and legal disclaimers

---

# Harmony Extension v0.3.4

### ✨ 新增提供商
- **智谱编码计划（Z.AI Coding Plan）** — 独立提供商，使用编码计划端点（`api.z.ai/api/coding/paas/v4`）。复用 `harmony.zhipu.apiKey`，不同基础 URL，提供高性价比的编码访问。

### 🐛 修复
- 修复了6个注册遗漏，导致 `zhipu-coding` 无法在侧边栏显示和正确路由（侧边栏下拉、primaryDirect 列表、模型三元表达式、状态字段、DirectPrimaryProvider 类型、isDirectPrimaryProvider 守卫）
- 收紧流程状态检测以减少误报：
  - 结束检测扫描最后 15% 而非 25%（防止响应中途的待办列表触发）
  - 工具散文检测跳过长响应（>1200字符）或含3+工具提及的响应（这些是摘要，非承诺）
  - 工具调用后路径使用新的 `getFlowStateViolationPostTool()` 完全跳过工具散文检测
- 为模型发现中的 JSON.parse 添加 try/catch，在服务商返回非 JSON 响应时提供更清晰的错误信息

### 📚 文档
- 更新 README（中英文），在架构图、提供商列表和法律免责声明中加入智谱编码计划
