# WSL2 局域网访问

服务监听 `0.0.0.0:3000`。先启动 `npm start`，再从手机打开启动日志中的 IPv4 地址。电脑、手机需在同一网络；访客 Wi-Fi/AP 客户端隔离会阻止互相访问。

## 先定位

WSL 内（绕过系统代理）：

```bash
curl --noproxy '*' http://127.0.0.1:3000/health
hostname -I
curl --noproxy '*' http://<局域网IP>:3000/health
```

Windows PowerShell：

```powershell
curl.exe --noproxy "*" http://localhost:3000/health
```

返回 `{"ok":true}` 表示 HTTP 到达服务；浏览器入座成功才验证 Socket.IO。单机通过不能证明手机可达。镜像网络下 Windows 用 localhost 的路径与手机从局域网 IP 的路径不同。

## Mirrored 网络

当前机器 `.wslconfig` 配置镜像网络，WSL 网卡地址为 `192.168.1.100`。Windows localhost 实测可访问，Windows 经自身 LAN IP 请求超时；不能据此断言外部手机能否访问。

如果手机打不开，而上述本机检查通过，在管理员 PowerShell 中为此游戏单独增加 Hyper-V 入站 TCP 3000 规则：

```powershell
New-NetFirewallHyperVRule -Name "CABO-3000" -DisplayName "CABO LAN TCP 3000" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 3000
```

删除该规则：

```powershell
Remove-NetFirewallHyperVRule -Name "CABO-3000"
```

这是待需时手工执行的管理员操作；本次实施未修改 Windows 防火墙配置。方法参考 [Microsoft WSL 网络说明](https://learn.microsoft.com/en-us/windows/wsl/networking#mirrored-mode-networking)。

## NAT 网络

若其他机器使用 NAT 模式，WSL 地址通常与 Windows LAN 地址不同，可在管理员 PowerShell 将 Windows TCP 3000 转到实际 WSL IPv4：

```powershell
# 用 wsl.exe hostname -I 的 IPv4 结果替换下面地址
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSL-IPv4>
New-NetFirewallRule -DisplayName "CABO LAN TCP 3000" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private
```

手机访问 Windows 的 LAN IP。WSL 重启后 IPv4 可能变化，需更新转发。清理：

```powershell
netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0
Remove-NetFirewallRule -DisplayName "CABO LAN TCP 3000"
```

不需要也不建议为了本游戏关闭整个防火墙。NAT 步骤见 [Microsoft 官方说明](https://learn.microsoft.com/en-us/windows/wsl/networking#accessing-a-wsl-2-distribution-from-your-local-area-network-lan)。
