# 联网与状态边界

## 房间和网络作用域

`RoomManager` 是唯一连接/事件入口，单进程最多四个 `Room`。每间各有席位、观战者、房主、引擎、版本与游戏命令去重记录。一个 100ms 定时器检查所有房间（包括离线大厅）；只对发生变化的房间推 `state`，只在摘要变化时推 `rooms`。

所有房间状态带 `serverId, roomId, generation`，游戏命令和同步也须提供三者。服务端校验实例、当前浏览器连接代次、正在查看的房间、角色和绑定席位。版本仅在同一实例/房间/代次比较。摘要仅含 `roomId,name,phase,playerCount,onlineCount,spectatorCount,hostName,joinable`；没有手牌及私密状态。

## 身份和管理事件

浏览器在首次创建/加入请求前使用 `crypto.getRandomValues` 生成 `browserId,secret`，保存在 `cabo-identity-v2`，同时持久化待完成事件与完整管理请求（含 `requestId`）。身份不写入 URL、公开状态或日志。存储不可写则拒绝新增席位；临时访客仍可观战。旧 `cabo-session` 凭据不升级为新身份。

- `session({browserId,secret,requestId,pendingRequestId?})`：只查询本身份，返回实例、当前 `session`、房间摘要。只有确实处理过对应请求才附 `receipt:{requestId,event,roomId?,generation}`；查询不恢复席位或私密视图。
- 管理请求共有 `{browserId,secret,serverId,generation,requestId}`。
- `create` 加 `{name,roomName?}`，创建者自动成为房主；默认房间名采用房间号，第五间拒绝。
- `join` 加 `{roomId,name}`，只允许大厅新增席位；已有席位使用恢复流程。
- `restore` 加 `{roomId,token,takeover?}`，成功轮换 token 和 generation 并返回当前个人视图。相同请求同连接重试返回当前视图；跨连接不能靠旧请求抢回绑定。
- `watch` 加 `{roomId,takeover?}`，`browse` 返回列表；玩家的席位与当前查看的房间分离。显式接管允许替换旧连接。
- `closeRoom` 加 `{roomId,confirm:true}`，仅当前房主可关闭。

管理成功回执包括 `{ok,serverId,session,rooms,view?}`。`session` 的 `roomId/playerId/token` 是保留的玩家席位，可能不同于正在观战的 `view.roomId`。不允许一个浏览器身份拥有多个席位。创建/加入/恢复都有精确请求去重；已关闭房间的旧创建请求不得创建替代房间。

首次确认丢失后，通过私密查询的精确请求回执证明本次操作已完成，再恢复对应目的地。不能仅凭代次增加一次猜测确认丢失。旧页面发现代次被取代时停止自动恢复，必须主动接管。暂时错误、限流和超时保留凭据及待完成请求，以 1、2、4、8 秒封顶退避自动恢复。

## 游戏命令、通知和生命周期

`command({serverId,roomId,generation,requestId,version,command})` 与 `sync({serverId,roomId,generation,requestId})` 仅对当前绑定房间生效。每个事件同步执行，入口读取一次时钟，先处理超时再验证及执行。每席缓存最近 256 个游戏请求的结果，重复请求返回当前视图而非旧私密牌面。更老请求由旧版本拒绝。客户端断线期间不缓存游戏操作，也不自动重放新命令；确认超时先同步当前状态。

`state` 按连接分别投影。`takenOver`、`removed`、`roomClosed` 含实例、房间、代次和原因；旧代次或无关房间通知不覆盖当前视图。关闭保留席位所在房间，不影响另一房间的观战；关闭正在观战的房间，不撤销另一房间的席位。

创建者为房主，断线后按入座顺序迁移至在线玩家。大厅返回列表/切房会离座，进行中保留离线席位，结束整场后才能离座并加入别房。最后席位离开立即关房；有席位时全玩家离线满五分钟关闭，玩家恢复才重置期限，观战者不延长。断线继续回合与揭示计时。全部数据在内存，服务重启丢失牌局/会话；更换访问地址、浏览器或清空存储不能按昵称认领。

每条消息最多 8 KiB，每连接所有请求合计 100 次/10 秒。应用面向局域网，没有账号或数据库。

## 牌面过滤与截止时间

暗牌仅 `{index,public:false}`，不包含卡牌真实标识、点数或花色，自身暗牌亦如此。公开牌和结算带 `card`。`pending`、`reveal` 和 `swapFeedback` 仅操作玩家可见。观战不含 `selfId,initial,pending,reveal,swapFeedback`；不影响席位容量或准备判定。

弃牌来源取牌以公共 `publicDraw:{actorId,card}` 独立投影，所有玩家/观战者可见。单换、同点合并或失败追加后的弃牌来源新牌始终公开，J/Q 后公开属性随牌移动。摸牌堆来源不生成公共取牌字段。开局/技能揭示使用服务端绝对截止时间，断线隐藏私密面，恢复只显示剩余时间。

本人 `swapFeedback:{outcome,index,deadline}` 只说明新换入牌的最终位置，不带牌面。单张、多张成功取最小原序号，失败为追加位置；完成后五秒到期。J/Q 换走标记位置、结算、大厅、新轮立即清除。前端新牌金边与“新换入”标记仅本人可见，减少动态效果时保留文字。

7/8 `skill:{actorId,kind:"peek"}` 向其他人提示偷看。9/10 另有 `targetId,index`，所有人显示被查看位置。J/Q `exchange` 使用两名不同玩家的独立位置，验证成功后的公共日志文本为“甲发动了交换技能：乙第 2 张 ↔ 丙第 4 张。”，发动者及观战者同样显示；不含暗牌点数。失败/非法/过期操作无成功提示。全部提示以原日志 `at+5000` 到期，刷新不续期，返回大厅隐藏。

CABO 持续提示使用 `caboCallerId,remainingFinalTurns`，到结算才消失。失败计分为手牌分加十，并列最低仍为零；QQKK 特殊计分优先，首次恰好 100 重置 50，超过 100 终局。

## 客户端和计时证据

URL `/?room=<id>` 或 `/?room=<id>&watch=1` 只保存查看目的地，前进/后退与按钮切换共用恢复流程。切房立即移除旧私密视图与选牌，旧 socket、epoch、代次、房间的迟到回执/状态不覆盖新状态。网络已连接不代表可操作；取得正确作用域的恢复视图后才解锁。

日志 `[cabo-timing]` 使用 `side,step,phase,durationMs,result,requestId`；不记录昵称、身份、token、牌面、完整视图或命令参数。客户端 start/send/ack/commit/paint；双 requestAnimationFrame 只表示绘制机会，非显示器实际呈现。服务端 handle 是同步处理至响应就绪的耗时，异步输出日志。两端各用 performance.now，通过请求号关联，不直接相减两端时钟。验收计时与四房间功能 RTT 不是容量或真实 LAN 吞吐基准。
