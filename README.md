# zcode-model-hub

[![CI](https://github.com/roiding/zcode-model-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/roiding/zcode-model-hub/actions/workflows/ci.yml)

**为 ZCode 桌面版一键拉取自定义供应商模型列表 —— 全平台、更新自适应、零常驻资源。**

融合并改进了两个上游项目的优点（见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）：
[HHQ-666/zcode-model-puller](https://github.com/HHQ-666/zcode-model-puller) 的
MutationObserver 自适应 UI 与 [CSSZYF/zcode-modelhub-patch](https://github.com/CSSZYF/zcode-modelhub-patch)
的手术式 asar 改写、严格锚点校验与多 API 方言支持。

## 为什么是这个项目

| 痛点 | zcode-model-puller | zcode-modelhub-patch | **本项目** |
|---|---|---|---|
| ZCode 更新后补丁失效 | 要重跑脚本 | 要重跑脚本 | **触发器自动重装，无感恢复** |
| 平台 | 实际仅 macOS | 仅 Windows | **macOS / Windows / Linux** |
| 依赖 | 需要 npx @electron/asar | 零依赖 | **零依赖（纯 Node 标准库）** |
| 版本耦合 | 部分锚点静默跳过 | 锚点写死构建 hash | **无锚点追加 + 格式级锚点 + 语义定位** |
| API 方言 | 仅 OpenAI 兼容 | OpenAI / Anthropic / Gemini | **OpenAI / Anthropic / Gemini** |
| 更新后诊断 | 无 | 明确报错 | **doctor 兼容性报告 + CLI 层永远可用** |

## 三层架构

```
层1 CLI/技能（100% 更新免疫）
  ~/.zcode/v2/config.json 原子读写 + 三方言拉取
  部署为 ZCode 技能/命令：对话里说"拉取 xxx 的模型列表"即可
      ↓ 不够用时
层2 自适应注入（按钮随 ZCode 更新自动回来）
  main/preload: 无锚点追加（EOF 追加 ipcMain.handle / contextBridge）
  renderer: 只挂 index.html 的 </body>（格式级锚点）+ MutationObserver 语义定位
  手术式重打包：数据区逐字节保留、app.asar.unpacked 不动、原子替换 + 读回校验
      ↓ 更新被删后
层3 自动重装（零常驻进程）
  macOS  : LaunchAgent（RunAtLoad + WatchPaths，内核事件驱动）
  Windows: 计划任务（登录时 + 每 6 小时，一次性运行毫秒级结束）
  Linux  : systemd user .path unit（PathChanged，inotify）
  ensure 快路径 = 一次 stat()；只有真发生更新才付出 哈希 0.3s + 重打包 1~5s
```

任何一层失败都不影响其他层：最坏情况 = UI 按钮暂时消失，CLI/技能照常拉模型。

## 安装

```bash
git clone <this-repo> && cd zcode-model-hub
./scripts/install.sh          # macOS / Linux
powershell -File scripts/install.ps1   # Windows
```

等价的裸命令：`node bin/zcode-model-hub.mjs install`。

安装做三件事：注入 UI 补丁（自动备份原版）→ 部署 skill/command 到 `~/.zcode/` → 注册自动修复触发器。
完成后**完全退出并重启 ZCode**，设置 → 模型供应商 → 添加/编辑渠道页会出现「⚡️ 拉取模型」按钮。

不想注入任何东西？只要层1：

```bash
node bin/zcode-model-hub.mjs sync --list     # 列出已配置供应商
node bin/zcode-model-hub.mjs sync --provider deepseek
node bin/zcode-model-hub.mjs sync --all
```

## 命令

| 命令 | 作用 |
|---|---|
| `install` | 注入 + 部署技能 + 注册触发器（`--no-watch` / `--no-skill` 可选） |
| `restore` | 还原官方原版 app.asar（按 manifest 里的原始哈希精确恢复） |
| `status` | 三层状态一览 |
| `doctor` | 只读深度体检；异常时生成 `~/.zcode/model-hub/doctor-report.json`（可携带提 issue） |
| `ensure` | 一次性自愈检查（触发器内部调用；`--check-only` 只诊断） |
| `sync` | 用户空间模型同步（`--list` / `--provider <id>` / `--all` / `--dialect`） |
| `watch` / `unwatch` | 仅注册/卸载自动修复触发器 |

选项：`--resources <dir>` 显式指定安装路径；`--force-close` 写入前强制关闭 ZCode（默认拒绝在运行时写入）。

## 安全模型

- **写入前**：ZCode 运行中一律拒绝（自动模式一律延迟，绝不自动杀进程）；检测到其他补丁（上游两项目的标记）拒绝叠加；macOS 检测 `ElectronAsarIntegrity`（fuse 启用时注入层不可用，明确报告而不是写坏应用）。
- **写入时**：同目录临时文件 + fsync + 尺寸校验 + 条目哈希读回校验 + 原子改名；手术式重打包保留原数据区与 `app.asar.unpacked`。
- **备份**：按官方构建哈希分目录冷备份，保留最近 2 个版本；`restore` 拒绝把未知状态错还原成旧版本（`--force` 覆盖）。
- **更新竞态**：双次哈希 debounce 识别"更新进行中"；正在运行 → 记录 pending，下次触发/启动前补齐。
- **隐私**：API key 只进用户自己的配置，不写日志、不进 manifest、错误信息自动脱敏（`key=***`）。
- **防呆**：`ensure` 的自动重装被强制锁定到它检查过的那个 resources 目录（回归测试覆盖）。

## 使用（注入后）

1. 添加/编辑渠道，填好 BaseURL（带不带 `/v1` 都行）和 API Key，选好 API 格式
2. 点「⚡️ 拉取模型」→ 弹窗中搜索/全选/仅选新模型（"已添加"自动标注防重复）
3. 可选「探测视觉(勾选)」：发 1×1 测试图实测识图能力，不靠模型名猜
4. 「确认添加并保存」→ 最终态语义：勾选的保留、未勾选的删除并记录墓碑（`zcode.deletedModels`），不会被下次同步复活

## 开发

```bash
node scripts/check-syntax.mjs   # 全模块 + 注入载荷语法检查
node --test                     # 28 个测试：asar 手术/校验、动态目标发现、
                                # 三方言解析、配置合并/墓碑、ensure 状态机、
                                # 以及"模拟 ZCode 更新 → ensure 自动重装"端到端
```

测试中的集成流程使用合成 asar 夹具（`test/helpers.mjs`），不触碰真实安装。

## 平台注意事项与故障排查

### macOS
- **写入 /Applications 报 EPERM**（Ventura 引入、Sequoia 最严格）：修改其他 App 的内容需要「App 管理」权限。系统设置 → 隐私与安全性 → App 管理 → 打开**运行本命令的应用**（在 ZCode 会话里跑就开 ZCode，在终端跑就开那个终端；列表里没有就 ➕ 手动添加 `/Applications/ZCode.app`）→ **完全退出并重开该应用**（TCC 授权只对重启后的进程生效）→ 重试。**sudo 无法绕过**。CLI 检测到这种情况会直接打印本指引。
- **ElectronAsarIntegrity（asar 完整性 fuse）**：若 ZCode 某天启用了它，被改过的 app.asar 会拒绝加载。`doctor` 会提前检测 Info.plist 并明确报告 `ENABLED`，注入层不会动手，CLI/技能层不受影响。
- **LaunchAgent 触发器**：注册在当前用户 `~/Library/LaunchAgents/com.zcode-model-hub.repair.plist`，其中写死了安装时的 node 绝对路径——升级或切换 nvm Node 版本后需重跑 `install` / `watch` 重新注册。`launchctl` 变更无需 sudo。

### Windows
- **是否需要管理员取决于安装位置**：ZCode 装在 `%LOCALAPPDATA%\Programs\ZCode`（默认）时普通权限即可；装在 `Program Files` 时需要用**管理员终端**运行 install/restore。
- **触发器**：优先用 PowerShell 注册计划任务（登录时 + 每 6 小时），PowerShell 不可用时自动回退 `schtasks` 每小时任务；`unwatch` 统一卸载。
- **杀软误报**：修改 app.asar 的行为可能被 Defender 或第三方杀软拦截，属误报，需自行加白名单。

### Linux
- **AppImage 不支持注入**（只读 squashfs 镜像）；CLI/技能层不受影响，也不要对挂载点强行写入。
- **触发器需要 systemd 用户会话**（主流桌面发行版默认就有）。极简环境没有时，改用用户级 `~/.local/share/applications/zcode.desktop` 包装器（`Exec=sh -c 'zcode-model-hub ensure && exec zcode'`，用户级 desktop 文件优先且不被更新覆盖），或手动定期跑 `ensure`。
- **安装路径**：自动探测 `/opt/ZCode`、`/usr/share/zcode` 等；其他位置用 `--resources <dir>` 指定 resources 目录。

### 通用
- **ZCode 自动更新会覆盖注入**：装了触发器会自动补回（事件驱动，通常几秒内）；没装触发器时，更新后手动重跑一次 `install` 即可（备份按官方版本哈希分目录管理，最近 2 版自动保留）。
- **运行中永不写入**：手动 install/restore 检测到 ZCode 正在运行会拒绝（`--force-close` 才允许强制关闭）；自动重装遇到运行中一律延迟，记入 `pending.json`，下次触发补齐。
- **排查顺序**：`status` 看三层各自状态 → `doctor` 深度体检（发现异常时生成 `~/.zcode/model-hub/doctor-report.json`，可携带该文件提 issue）→ 视图层坏了也先确认 `sync` 仍可用（它永远可用）。

## License

MIT。上游思路致谢见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
