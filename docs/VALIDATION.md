# 实施与验收记录

## 任意位置交换与公开技能提示（2026-10-09）

本轮按用户修正规则：J/Q 交换任意两名不同玩家各一张牌，包括自己与对手、两名对手，双方序号独立；下面历史验收中的“同位置”不再代表当前规则。其他玩家会看到 5 秒技能发动提示，不含被查看牌面；立即结算也保留提示至原截止时间。

隔离目录：`/home/van/.config/superpowers/worktrees/cabo/any-card-exchange`，分支 `fix/any-card-exchange`。预览端口 3001，自动化测试端口 3100；构建产物仅写本目录的 `apps/web/dist` 与 `dist/server`。正式目录 `/home/van/github/cabo` 的 3000 服务不重启、不部署，本轮已记录其 67 个生产文件哈希用于复核。

新增引擎/真实网络覆盖：J/Q 两种点数、不同玩家及位置、手牌数量不同、两名对手、公开状态随牌移动、暗牌过滤、被移动位置的提示清理、非法位置/玩家/旧消息拒绝，以及三种技能的公开提示。新增浏览器覆盖：三人独立身份、同一玩家改选/取消、两名对手、手机切换保留选牌、技能提示及到期、立即结算仍提示。既有双人 J/Q 场景改为独立位置，并覆盖 4 张手牌与 3 张手牌的交换。

开发中发现并修正测试夹具的浏览器身份复用、桌面隐藏标签页定位；审查发现并修复立即结算时技能提示被隐藏。引擎/联网用例与公开提示用例分别保存失败起点于 `artifacts/exchange-red.log`、`artifacts/skill-notice-red.log`；结算提示修复前失败记录为 `artifacts/notice-settlement-red.log`。Chromium 桌面/手机新功能定向复测 4/4 通过，日志 `artifacts/exchange-targeted.log`。原始日志、截图、报告均只保留在本机。

最终类型检查、生产构建及 Prettier 检查通过，规则/真实联网测试 73/73 通过。完整浏览器回归 31/32 通过（5.5 分钟），新增的两项场景在 Chromium/WebKit 桌面/手机共 8/8 通过；唯一失败为本轮之前已有的 Chromium 手机“断网后新换入提示到期”2800ms 超时，未改动该断言，也不能宣称全量通过。日志 `artifacts/exchange-e2e-final.log`，完整报告/失败 trace 备份在 `artifacts/exchange-full-results/`。本轮功能代码审查及结算提示修复复核通过。最后同步了操作标题“选择两名玩家各一张牌”，重新构建后 Chromium 桌面/手机选牌与提示用例 2/2 通过，日志 `artifacts/exchange-wording-final.log`。



## 当前目录运行验证（2026-10-09）

项目现位于 `/home/van/github/cabo`，已建立 Git 仓库，远程为 `vandoor/cabo`。下文 2026-10-07 的目录、未提交状态和进程记录均为历史记录。

本次使用 Node.js 25.8.0、npm 11.19.1。生产模式 `npm start` 已实际启动：WSL 与 Windows 的 `localhost:3000/health` 均返回 `{ "ok": true }`，网页及其 JS/CSS 资源返回 HTTP 200，真实 WebSocket 入座/离开通过，生产 `/__test/final` 返回 404。未进行其他实体设备的局域网验证。

首次检查出现一次 Chromium 手机视口的换牌提示离线到期断言超时（2800ms）；随后执行环境重启，整轮未完成。不修改源码或断言，原用例连续复测 3 次全部通过，但不能据此排除偶发时序问题。首次日志为 `artifacts/check-20261009.log`，失败 trace 保留于 `artifacts/check-20261009-interrupted/test-results/`，复测日志为 `artifacts/recheck-single-swap-20261009.log`。

重新执行完整 `npm run check`：类型检查、54 项规则/联网测试、生产构建通过；24 项浏览器测试中 23 项通过，WebKit 手机视口在同一处离线提示消失断言超时，因此整条命令退出码为 1，不能记为全量通过。完整日志为 `artifacts/check-20261009-final.log`，完整报告与失败 trace 保留于 `artifacts/check-20261009-complete/`。WebKit 该用例随后原样连续复测 3 次全部通过，日志为 `artifacts/recheck-webkit-swap-20261009.log`。该间歇性失败根因尚未确定，本次未修改产品源码或测试断言；单项复测通过不代表已修复。

新增 `.gitignore`，依赖目录、构建产物、测试报告和原始日志保留在本机，不纳入版本控制；提交保留源码、测试、锁文件、文档和 SVG 素材。

## 初次实施（2026-10-07）

日期：2026-10-07；路径：`/home/van/code/cabo`。保留原 `desc.txt` 和 `req.txt`，在原本无 Git 的目录建立工程，未创建提交或推送。

## 实现范围

已实现 React/Vite 前端、Express/Socket.IO 同端口服务、独立 TypeScript 规则引擎、会话恢复、隐私投影、计时、积分、多轮/终局、SVG 素材及中文手机/桌面交互。生产状态保存在内存。

## 自动验证

最终命令：`npm run check`，退出码 0，原始输出在 `artifacts/check.log`。

- `npm run typecheck`：通过。
- `npm test`：42 项通过（32 条规则、10 条实际 Socket.IO 网络/隐私测试）。
- `npm run build`：通过，产物 `apps/web/dist`、`dist/server/index.js`。
- `npm run test:e2e`：16 项全部通过（4 个场景 × 4 个浏览器/视口组合），耗时 2.7 分钟。
- `npm audit`：当前安装的全部依赖 0 已报告漏洞。
- 素材生成：54 个牌面 + 1 个牌背 + 8 个图标；游戏使用 52 张牌。

规则覆盖：2/3/4 人牌数守恒、初始限时及部分选牌补齐、成功/失败交换和顺序、Joker 同点数、同位置技能、查看截止、CABO 后最后回合、摸牌堆耗尽、QQKK 优先、首次/再次 100 分、>100 终局、并列赢家、首家轮换和重新开场。

真实网络覆盖：2–4 客户端/满员拒绝、非法命令、过期版本、重复请求、暗牌实际消息过滤、待处理抽牌重连、过期揭示不重播、断线自动操作、身份接管、房主转移、大厅离线清理、房主权限、离开/踢出及凭证撤销。

浏览器矩阵：Chromium 桌面/Pixel 7 视口、WebKit 桌面/iPhone 13 视口。每组执行四场景：

1. 两人开局、CABO、刷新保留抽牌、轮末明牌、8 秒冷却和轮换首家。
2. 自己看牌技能、对方收不到私密遮罩、失败多换牌、五张手牌和无横向溢出。
3. 对手看牌、同位置交换、终局及重新开场清分。
4. 注入一次真实服务端 STALE 拒绝，验证初始选牌高亮回退、重选成功与刷新恢复。

特殊技能和终局 UI 场景使用仅测试进程里的牌堆调整/积分预设；规则计分由独立引擎测试验证，不将预设场景声称为自然长局压力测试。测试只运行在 `127.0.0.1:3100`，生产 3000 无场景控制路由（实测 `/__test/final` 返回 404）。

报告：`playwright-report/index.html`。截图：`artifacts/table-{chromium,webkit}-{desktop,mobile}.png`。已人工查看 Chromium 桌面/手机截图，检查自己的牌与操作顺序、公开牌、编号和页面宽度；WebKit 的行为由自动断言验证。

## 审查与修复

独立规则/服务规格审查及最终质量审查已完成，发现的问题已修复并复审：

- 同一请求内跨过截止点导致旧版本继续执行：统一入口时间，加入失败后转绿的真实 Socket.IO 回归。
- 离开房间在发送确认前断开连接：先撤销席位并确认，再结束连接。
- 过期的初始部分选牌被拒绝后仍高亮：按当前服务端视图同步部分选择，保留未确认双选草稿；加入失败后转绿的浏览器回归。
- 测试中不同连接消息的到达顺序不固定：接管测试等待旧连接的实际 disconnect 事件再断言，未降低行为要求。首次失败日志保留为 `artifacts/check-before-event-wait.log`。

## 运行与设备边界

- 生产模式：`npm start`，当前监听 `0.0.0.0:3000`，进程 PID 记录于 `artifacts/server.pid`。
- WSL 内 `127.0.0.1:3000/health` 和 `192.168.1.100:3000/health`：通过；页面 HTTP 200。
- Windows `curl.exe --noproxy "*" http://localhost:3000/health`：通过。
- Windows 经 `192.168.1.100:3000`：请求超时，当前镜像网络应区分宿主 localhost 路径和外部 LAN 路径。
- `PORT=3002 npm run dev`：Vite 5173 页面/health 代理均 HTTP 200，真实 WebSocket 入座/离开通过。验证后已停止开发进程，仅保留生产服务。
- **同一局域网另一台实体电脑、真实手机浏览器：未实测。** 已请求用户设备侧反馈，目前未收到，不能宣称局域网真机验收通过。排查步骤见 `docs/WSL.md`；本次未改 Windows 防火墙。

## 此 WSL 的浏览器依赖

当前无免密 sudo。浏览器已下载到 `~/.cache/ms-playwright`；40 个 Ubuntu 库包解压在 `~/.cache/cabo-playwright-libs`，WebKit 缓存的 `sys/lib` 添加对应库链接，未修改系统安装。Chromium 与 WebKit 均已完成实际启动/DOM/点击/截图 smoke。

`scripts/e2e.mjs` 检测上述缓存目录（可用 `CABO_PLAYWRIGHT_LIBS` 指定），设置 `LD_LIBRARY_PATH`。Playwright 的 ldconfig 先决检查无法读取用户解压的库，因此在存在本地库时跳过该检查；**实际浏览器启动和全部用例仍照常执行**。日志里的颜色环境提示与这一先决检查提示不是用例跳过。

其他机器建议直接 `npx playwright install --with-deps chromium webkit`。无需该缓存目录时测试启动器不会改动浏览器依赖环境。

## 换牌位置提示更新（2026-10-07）

新增本人私密 `swapFeedback`：单张交换、多张合并成功与失败追加均报告最终位置，固定为交换完成后 5 秒。新牌保持背面，仅对应位置显示金色边框、“新换入”及一次落位强调；普通广播不重播动画，刷新只恢复剩余时间，减少动态效果时保留文字与边框。J/Q 换走标记位置、结算、大厅或新轮会清除提示。

本轮修改文件：

- `packages/game/src/types.ts`、`engine.ts`、`engine.test.ts`：协议、服务端结果与生命周期、规则回归。
- `apps/server/src/room.test.ts`：真实 Socket.IO 私密消息、恢复截止时间和大厅清除回归。
- `apps/web/src/App.tsx`、`style.css`：本人提示、独立新牌动画与减少动态效果支持。
- `tests/e2e/game.spec.ts`、`server.ts`：三种结果、刷新/离线到期、技能清除和确定性合并场景。
- `docs/PLAN.md`、`PROTOCOL.md`、`VALIDATION.md`：批准方案、协议与本轮记录。

当前目录仍无 Git 元数据，改动保留在上述工作区文件，未创建提交或推送。本轮仅完成实现、构建和测试，未执行生产服务部署或真机 LAN 验收。

新增浏览器断言先在旧实现上因缺少提示失败，截图和 trace 保留在 `artifacts/swap-feedback-red-results/`。首次完整回归有 23/24 浏览器用例通过，唯一失败为 WebKit 桌面在已完成离线到期断言后，清理阶段等待网络恢复超出 5 秒；Socket.IO 默认连接超时为 20 秒。清理改为恢复网络后刷新，并额外验证过期提示不重现。该次日志和失败 trace 保留在 `artifacts/swap-feedback-check-before-cleanup-fix.log`、`artifacts/swap-feedback-before-cleanup-fix-results/`，单项复测通过，日志为 `artifacts/swap-feedback-webkit-recheck.log`。

规格审查与质量复审通过；已修正新牌可选择时悬停覆盖金色边框的问题，并让动画断言同时检查按钮和图片。人工查看了 Chromium 桌面单张/失败截图、手机单张/合并截图，以及 WebKit 桌面合并、手机失败截图，确认标签、编号、文案与暗牌位置一致。

最终 `npm run check` 退出码 0，日志 `artifacts/swap-feedback-check.log`：类型检查通过，54 项规则/联网测试通过，生产构建通过，24 项浏览器用例全部通过（6 场景 × Chromium/WebKit 桌面/手机视口，3.6 分钟）。修改的 8 个源码/测试文件通过 Prettier 检查。

最终浏览器报告：`playwright-report/index.html`；新截图：`artifacts/swap-{single,merge,failed}-{chromium,webkit}-{desktop,mobile}.png`。除原有场景外，覆盖新牌牌背与标签、唯一高亮、结果位置、其他玩家无提示、刷新剩余时间、无后续状态推送时客户端到期、到期后再次刷新不重现、减少动态效果与技能即时清除。
