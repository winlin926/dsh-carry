# 发布约定

插件、服务端版本、Git 标签、GitHub Release 与 npm 包使用同一版本号。节点发现协议的 `protocol` 版本独立于软件版本。

开发期间使用提交哈希识别构建。需要分发预发布包时使用 SemVer 预发布标识，例如 `1.2.0-rc.1`。正式发行只使用尚未发布过的版本号。

## 提交与分发内容

| 去向 | 内容 |
| --- | --- |
| GitHub 源码仓库 | `src/`、`remote-server/` 源码与部署模板、`tests/`、`scripts/`、CI、两份锁文件、构建配置、当前文档、README 截图、许可证、第三方兼容补丁 |
| npm 包与 GitHub Release 附件 | 同一个 `.tgz`，仅含 `lib/*.js`、`lib/types/**/*.d.ts`、`package.json`、`cordis.patch.yml`、`assets/logo.png`、`locale/*.json`、`README.md` 与 `LICENSE` |
| 仅本机保留 | `node_modules/`、构建目录、QA 数据、日志、包清单、`.tgz`、真实 `.env`、数据库、设备授权、主机身份、证书与本地 AI 工作目录（`.agents/`、`.mimosa/`、`.mnemon/` 等） |

`tests/fixtures/` 中的证书和私钥只用于失败场景与本机测试，属于公开测试数据，不能用于部署。`.env.example` 只有占位值，可以提交。服务端源码不塞入插件安装包，需要自托管时从仓库构建。

## 发行说明模板（`docs/release-notes.md`）

推送 `v*` 标签后，[publish.yml](../.github/workflows/publish.yml) 会自动读取 [release-notes.md](release-notes.md) 第 1 行的 `# ...` 作为 GitHub Release 标题、第 3 行起作为 Release 正文。所有版本的发行说明须严格遵守以下统一格式：

1. **标题**：第 1 行固定写 `# vX.Y.Z`（只保留版本号，不附加 `— 副标题`）。
2. **版本概览**：紧跟标题留一空行后，用 1~2 句概括该版本的适用场景、核心改动与宿主版本要求。
3. **固定二级章节顺序**（按当前版本实际是否有内容保留对应章节，**禁止另起其他二级标题名**，统一使用标准 Markdown `- ` 无序列表）：
   - `## 新增` —— 每条统一以「新增了……」开头。
   - `## 优化与变更` —— 体验或内部结构优化统一以「优化了……」开头；兼容性或行为变更写明具体变化与影响范围。
   - `## 修复` —— 每条统一以「修复了……的问题」表述清楚触发条件与修正结果。
   - `## 升级与兼容性` —— 固定给出统一安装命令格式，并明确说明是否需要重启 DSH、是否需要重新扫码配对，以及是否需要同步升级 `remote-server`：
     ```powershell
     dsh plugin --profile <profile> add @winlin926/dsh-carry@X.Y.Z
     ```
   - `## English Summary` —— 给出 2~5 条简明英文要点（小版本修补也可保留 2~3 条）。

## 发布检查

```powershell
pnpm install --frozen-lockfile --ignore-scripts
npm ci --prefix remote-server --ignore-scripts --no-audit --no-fund
pnpm lint
pnpm typecheck
npm --prefix remote-server run typecheck
pnpm test
npm --prefix remote-server test
pnpm build
# 可选：确认 lib/ 产物大小未异常增大（参考值约 320 KiB）
# du -sh lib/   # Linux/macOS
# (Get-ChildItem lib | Measure-Object -Sum Length).Sum / 1KB   # PowerShell
npm pack --dry-run --ignore-scripts --json > package-manifest.json
node scripts/check-package.mjs package-manifest.json
# Windows PowerShell:
Remove-Item -LiteralPath package-manifest.json
# Linux/macOS (CI):
# rm package-manifest.json
```

按影响范围运行[测试指南](verification.md)，更新 [release-notes.md](release-notes.md)。检查 `git diff --check` 和 `git status --short`，只提交发行所需的源文件、测试与文档。

推送源码分支会运行 CI。通过 Windows/Linux 检查后，创建并推送与包版本一致的 `v*` 标签。标签触发 `.github/workflows/publish.yml`，运行两端检查，校验打包结果，向 npm 发布并将同一安装包附到 GitHub Release。

已发布的版本号与标签不可复用；更正已发布版本时，发布新的修订版本并保留原有发行记录。
