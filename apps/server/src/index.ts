import { networkInterfaces } from "node:os";
import { createRoomServer } from "./server.js";
const port = Number(process.env.PORT ?? 3000);
const server = createRoomServer();
server.http.listen(port, "0.0.0.0", () => {
  console.log(`CABO · 本机 http://localhost:${port}`);
  for (const entries of Object.values(networkInterfaces()))
    for (const address of entries ?? [])
      if (address.family === "IPv4" && !address.internal)
        console.log(`CABO · 网络 http://${address.address}:${port}`);
  console.log("同一局域网打开以上地址；WSL NAT 地址可能需 Windows 转发。");
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
