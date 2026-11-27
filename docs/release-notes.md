# v0.7.2

围绕自托管中继隧道大包分片、配对完成通知以及公网节点切换与边界加固，并完成工程化与代码规范整理（待同步 `package.json` 版本号至 `0.7.2` 后发布）。

## 修复

- 修复了经由自托管中继隧道传输超过帧长度上限的 WebSocket 大消息时直接断连的问题，现会在两端自动按分片传输并安全重组。
- 修复了自托管中继配对双方先后批准时可能漏发或重复发送 `pair.complete` 通知的问题，确保配对完成事件精确投递一次。
- 修复了切换至自托管节点时仍残留旧网关固定公网域名的问题。
- 修复了删除当前正在使用的网关节点时未自动停止公网连接并清理域名的问题。
- 修复了使用自托管节点时设置面板仍错误检查并提示网关证书或域名错误的问题。
- 修复了切换回局域网模式或停用连接时未彻底清理 `lanTls` 状态的问题。
- 修复了 `remote-server` Docker 构建上下文遗漏 `src/remote/node-api.ts` 导致镜像编译失败的问题。

## 优化与变更

- 优化了共享契约目录结构：锁定 `src/remote/` 为唯一纯契约目录，并加入自动架构守卫测试防止非契约文件混入。
- 优化了客户端面板实现：将面板组件迁移至 React JSX，提升可读性与类型安全。
- 优化了启动脚本构建方式：将 `boot` 脚本改为 tsdown 独立编译的浏览器 IIFE 产物，与宿主端构建解耦。
- 优化了宿主端代码组织：拆分 Host 控制层与隧道代理大文件，降低单文件复杂度。
- 优化了代码质量保障：接入 Biome 格式化与静态检查并纳入 CI 门禁。
- 优化了远端管理权限边界：禁止通过远程会话调用添加、检测、切换或删除公网节点等仅限本机的敏感操作。

## 升级与兼容性

```powershell
dsh plugin --profile <profile> add @winlin926/dsh-carry@0.7.2
```

- 也可直接在 DSH 插件页更新，更新后需重启 DSH 宿主以使服务端插件逻辑生效；已配对的手机、公网节点记录和既有设置继续保留，无需重新扫码。
- **自托管公网节点用户**：请同步升级仓库内的 `remote-server`，以获得 WebSocket 大消息分片重组与 `pair.complete` 单次精确投递修复。

## English Summary

- **Fixed oversized WebSocket frames over relay tunnels**: Large messages are now fragmented and reassembled safely on both ends instead of breaking the tunnel.
- **Fixed relay pairing notifications**: Guaranteed single delivery of `pair.complete` when both sides approve a relay pairing.
- **Fixed stale state during node switches and deletions**: Prevented leftover gateway domains, certificates, and `lanTls` states when switching to a self-hosted node, deleting the active node, or returning to LAN mode.
- **Blocked non-local public-node management from remote sessions**: Adding, detecting, switching, or deleting public nodes now requires a local connection.
- **Modularized codebase**: Locked `src/remote/` as the sole shared contract directory with architectural guard tests; migrated client panel to React JSX; compiled the boot script as a standalone browser IIFE via tsdown; split Host controllers and tunnel proxies into smaller modules; integrated Biome lint/format into CI.
