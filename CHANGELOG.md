# Changelog

**中文** | [English](CHANGELOG.en.md)

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.1.0] - 2026-11-03

首个可发布版本。

### Added

- `redmine` SourceKind：配置卡片、Policy（数字用户 id 白名单 + 两行准入表）、健康条目、worker 环境变量与 facts。
- 轮询：`updated_on:desc,id:desc` 倒序分页 + `overlapSeconds` 窗口游标；不发送服务端时间过滤（兼容 Redmine 2.3）。
  整轮成功才推进游标；单条 403/404 跳过；异常时间戳/时区整轮失败。
- Trigger：issue 与 journal 映射、`@mention` 与指派识别、私有备注与 agent 自身评论跳过、稳定 id 去重。
- 上下文：`threadContext` 的 `thread`/`root`/`parent` 分页，消息 id 为 `issue:<id>` / `journal:<id>`。
- 图片：`<img src="/attachments/...">`、`!file.png!`、`attachment:file.png` → 下载为模型可见附件；
  校验模型图片能力与字节上限；私有备注不进上下文。
- 回写：只写 `notes`，隐藏 marker 幂等，`writeBack` 开关，403/404 记为 `gone`。
- 运维：只读探测脚本 `scripts/probe-redmine.sh`、安装/排错文档、Docker 本地联调记录。
- 112 个单元/契约/mock HTTP 用例；在 Redmine 6.1（非管理员 agent 账号）上完成真实链路验证。
