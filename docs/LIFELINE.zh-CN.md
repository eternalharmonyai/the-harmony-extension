# 🔴 Harmony 生命线 — 无需 VS Code 聊天即可修复

**何时使用：** 当 `@harmony` 聊天不可用、扩展宿主损坏，或你需要从纯终端修复扩展时。以下所有操作均在终端中运行，**完全不涉及 VS Code 聊天**。请确保此文件可离线阅读（打印或在记事本中打开）。

> 将 `<extension-root>` 替换为扩展的安装目录，或你保存其源码检出目录的位置。

## 0. 黄金规则

- 每个会改动状态的 CLI 步骤都有 `--confirm` 确认门槛，并在 `.harmony/` 下写入回执。
- 补丁之前会先有快照（`snapshot create`），因此没有任何操作是单向的。
- 之前的 VSIX 构建永远只需一条安装命令即可回退 — 见第 2 步。

## 1. 从外部诊断（只读）

```powershell
cd <extension-root>

# Hub/后端/锁/监督者摘要
node bin/harmony-cli.js status
node bin/harmony-cli.js diagnose

# VS Code 扩展宿主错误（哪个窗口、什么失败）
$logs = Join-Path $env:APPDATA 'Code\logs'
Get-ChildItem $logs -Directory | Sort-Object Name | Select-Object -Last 3 -ExpandProperty Name
# 然后：Get-ChildItem "$logs\<session>" -Recurse -Filter *.log | Select-String -Pattern 'harmony' -List
```

## 2. 回退到之前的 VSIX（最可靠的撤销方式）

```powershell
# 将 <path-to-vsix> 替换为之前可用的 .vsix 文件。
# 注意：PATH 上直接使用的 `code` 可能是其他编辑器的替身 — 如果 `code` 不是 VS Code 本身，
# 请使用你的 VS Code CLI 的完整路径。
code --install-extension <path-to-vsix> --force
```

然后重载窗口：`Ctrl+Shift+P` → `Developer: Reload Window`。

## 3. 从外部应用补丁（受保护）

```powershell
# 始终先做快照
node bin/harmony-cli.js snapshot create

# 通过策略/锁/git-apply 校验门槛应用 unified-diff 补丁文件
node bin/harmony-cli.js run-fail-fix --apply --patch-file .\fix.patch --confirm

# 如果出错了：
node bin/harmony-cli.js snapshot list
node bin/harmony-cli.js snapshot restore --latest --all --confirm
```

## 4. 从外部重建 + 重装

```powershell
cd <extension-root>
npm run package
code --install-extension .\harmony-extension-<version>.vsix --force
```

## 5. 编辑器身份速查表

如果 PATH 上的 `code` 指向的不是你用于 Harmony 的那个编辑器，请改用正确 CLI 的完整路径：

| 命令 | 安装到 |
|---|---|
| `code --install-extension` | PATH 上该 CLI 所属的编辑器 |
| `"...\Microsoft VS Code\bin\code.cmd" --install-extension` | VS Code |
| VS Code 安装根目录 | `...\Microsoft VS Code\<commit-hash>\resources\app\...`（近期构建中为哈希目录） |

## 6. 当 VS Code 自身改变了规则

1. `node bin/harmony-cli.js self-healing status` — 源码/打包/安装就绪状态。
2. 检查已安装的 workbench 包中已改变的 API 真相：
   ```powershell
   $wb = Get-ChildItem '...\Microsoft VS Code\*\resources\app\out\vs\workbench\workbench.desktop.main.js' | Select-Object -First 1
   Select-String -Path $wb.FullName -Pattern 'your-search-string' -SimpleMatch
   ```
3. 补丁、快照、重建、重装 — 上面的第 3–4 步。

## 7. 无需聊天即可浮动 UI（原生窗口）

```powershell
node bin/harmony-cli.js ui native          # 后端 + 原生浮动聊天窗口
node bin/harmony-cli.js ui serve --open    # 浏览器仪表盘备用方案
```
