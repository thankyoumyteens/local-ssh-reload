# Local SSH Reload

自己维护的最小 VS Code 本地扩展，无第三方依赖、无遥测、不调用 shell、
不读取 SSH 配置或密钥、不主动建立额外 SSH 连接。
源码全部包含在 VSIX 中；不会发布到 Marketplace。

## 开发环境

- VS Code 1.85 或更新版本。
- Node.js 18 或更新版本（运行测试；扩展运行时由 VS Code 提供）。
- Python 3（生成 VSIX 安装包）。
- 无需安装 npm 依赖。

## 项目结构

```text
extension.js          扩展入口、连接检测、状态管理与重载
policy.js             重载策略、冷却时间和次数限制
logger.js             JSONL 日志、路径配置与轮转
package.json          扩展清单、配置项和开发命令
package.py            无依赖 VSIX 打包脚本
test/                 恢复策略、模拟扩展和日志测试
```

## 安装

1. 禁用之前安装的 RemoteAutoReload，避免两个扩展同时重载。
2. 运行 `Extensions: Install from VSIX...`，选择 `local-ssh-reload-0.2.1.vsix`。
   安装到本机，不要安装到远端。
3. Reload Window 一次以启用扩展。扩展在启用的 SSH 窗口启动时自动将本机用户设置
   `window.dialogStyle` 设为 `custom`，已是 `custom` 时不重复写入。

## 行为与限制

- 只在 Remote SSH 窗口工作，每轮检查后等待 5 秒。
- 使用 VS Code `workspace.fs.stat` 检查当前远程目录的元数据，不读取内容。
- 连续 3 次收到 `Unavailable` 或 `Unknown` 错误后自动执行 Reload Window。
- 单次探测超过 10 秒视为不确定，不触发重载。同一目录最多一个探测挂起。
- 有未保存编辑器或已知的活动调试会话时暂缓重载。
- 不能探测终端内任务是否适合重载；重载仍可能中断任务、端口转发和会话。
- 每个工作区 15 分钟内最多重载 3 次，两次至少间隔 60 秒，计数跨重载保存。
  达到上限后等待旧记录过期，不无限快速重载。
- 不测试 SSH 可达性，因此网络仍断开时也可能尝试重载；上限约束这个行为。
- 启动时自动设置本机用户级 `window.dialogStyle: custom`，不修改远端或项目设置。
  这会影响该用户配置中的所有 VS Code 窗口；卸载扩展后保留此设置。
  扩展被 `localSshReload.enabled: false` 关闭时不自动修改。
  写入失败会记录异常并提示手动设置，连接检测继续运行；不会为此强制重载。
  已存在的原生弹窗仍需手动关闭一次。
- 不保证每种断线都能识别：如果文件 API 一直挂起或返回其他错误，会等待。
- 扩展需要本地 extension host 仍能响应；只支持受信任的工作区。
- VS Code 扩展本身没有细粒度权限沙箱；以上描述是代码实际行为，而非系统权限限制。

命令面板可运行 `Local SSH Reload: Pause`、`Resume`、`Show Log`。
暂停只作用于当前窗口生命周期。要持久关闭，设置
`"localSshReload.enabled": false` 或禁用扩展。

## 日志

本机用户设置示例：

```json
{
  "localSshReload.logFilePath": "~/Library/Logs/local-ssh-reload/reconnect.jsonl",
  "localSshReload.logLevel": "debug"
}
```

- 日志同时写入输出面板 `Local SSH Reload` 和本机文件，格式为 JSONL，每行一条。
- `logFilePath` 是文件路径，支持绝对路径与 `~/`；自动创建父目录。
  留空使用 VS Code 为扩展提供的日志目录，具体路径见 `log.configured` 记录。
  相对路径会报错并关闭文件日志。配置修改立即生效，无需重载。
- 默认 `debug` 记录每轮检测、耗时、目录 URI、原始异常代码/消息/堆栈、
  连续失败次数、重载决策、未保存/调试状态、次数限制、配置变化、暂停/恢复、启动/退出。
  `info` 仅记录状态和重要操作；也可选 `warn`、`error`、`off`。
- 每条包含 UTC 时间、会话 ID 和进程 ID，便于关联重载前后的不同会话。
- 单文件约 5 MiB 后轮转，保留一个 `.1` 备份；新建文件权限为 `0600`，
  已有文件权限保持原样。多窗口建议使用不同的日志文件：同路径会混写，轮转不支持跨进程锁。
- 写入失败在输出面板报错，文件写入暂停；修改日志配置可重试。
  文件写入异步排队，重载前最多等待 1 秒刷盘，文件系统卡住不会阻止恢复。
  崩溃或超出刷盘期限可能丢失最后几条日志。
- 日志不记录文件内容、私钥或环境变量，但包含主机/目录以及原始错误文本；分享前请检查。

## 验证与打包

```sh
npm test
python3 package.py
```

不需要 `npm install`。测试覆盖恢复策略与模拟 VS Code API 行为；真实掉线与弹窗
仍需要在 VS Code 中验证。安装包使用标准 VSIX ZIP 结构，无安装脚本。

在项目目录运行命令，安装包生成在同目录。`*.vsix` 和日志文件已被 Git 忽略。
也可用 `npm run package` 打包。

本地调试可运行：

```sh
code --extensionDevelopmentPath="$PWD"
```

在打开的 Extension Development Host 中连接 SSH 主机，查看
`Local SSH Reload: Show Log`，验证断线检测、恢复及日志文件写入。
