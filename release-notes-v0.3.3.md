# Harmony Extension v0.3.3

### ✨ Provider Updates
- Tencent/Hunyuan updated to hy3-preview model with native TC3-HMAC-SHA256 authentication
- New provider: Zhipu (Z.AI / GLM) with GLM-5.1/5.2 models
- Moonshot/Kimi temperature parameter fixed in agent loop
- Provider routing corrected for all 10 direct providers
- Scoped configuration keys for each provider in VS Code settings

### 🌐 Internationalization (i18n)
- Ask-question webview, flow-state whisper, and tool routing messages now support Chinese
- Release notes available in both English and Chinese

### 🧠 New Tools & Features
- `harmony_semantic_search` — semantic code search across all indexed projects
- Scalable vision routing with configurable fallback order
- Multi-key slot architecture for provider API keys
- Sidebar model selector shows all providers in a clean organized list

### 🔧 Quality & Stability
- HTTP error sanitization across all providers
- Flow-state conclusion guard + counter fixes
- 5-tier quality upgrade: schema validation (Zod), property-based testing (fast-check), storage integrity
- Test suite with tsx runner (46/46 tests passing across 22 files)
- Extension wired to hub memory bridge for cross-session context

---

# Harmony Extension v0.3.3

### ✨ 提供商更新
- 腾讯混元更新至 hy3-preview 模型，支持原生 TC3-HMAC-SHA256 认证
- 新增提供商：智谱 (Z.AI / GLM)，支持 GLM-5.1/5.2 模型
- 修复 Moonshot/Kimi 在代理循环中的 temperature 参数
- 修正全部 10 家直接提供商的代理路由
- 每家提供商在 VS Code 设置中拥有独立配置键

### 🌐 国际化
- 提问界面、流程状态提示和工具路由消息现支持中文
- 发布说明提供中英双语版本

### 🧠 新工具与功能
- `harmony_semantic_search` — 跨项目语义代码搜索
- 可配置回退顺序的可扩展视觉路由
- 提供商 API 密钥的多槽架构
- 侧边栏模型选择器以整洁列表展示所有提供商

### 🔧 质量与稳定性
- 所有提供商的 HTTP 错误净化处理
- 流程状态结束守卫与计数器修复
- 五层质量升级：Schema 验证 (Zod)、基于属性的测试 (fast-check)、存储完整性
- 测试套件 (tsx runner，46/46 测试通过，覆盖 22 个文件)
- 扩展连接至中心记忆桥，支持跨会话上下文
