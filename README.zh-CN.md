# NatTypePigeon 后端

[English README](README.md)

本项目提供一个使用 WebRTC 通过 WebSocket 进行信令的最小 NAT 类型检测后端。

## 前置要求

1. 准备一台安装 **Node.js ≥ 18** 的机器（推荐使用 LTS 版本）。
2. 确保本地可访问 npm 官方源，或提前配置镜像源以便安装依赖。
3. 如果计划使用 Docker，请安装 Docker Engine（24+）与 docker compose 插件。

## 本地运行步骤

1. **克隆仓库**

   ```bash
   git clone https://github.com/your-org/NatTypePigeon.git
   cd NatTypePigeon
   ```

2. **准备环境变量**

   ```bash
   cp .env.example .env
   # 根据需要调整端口、STUN 服务器列表或日志等级
   ```

   默认配置遵循 `agent.md`：

   ```
   DISABLE_LIMIT=true
   RESULT_PERSIST=false
   STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
   ```

3. **安装依赖**

   ```bash
   npm install
   ```

4. **启动开发服务器**

   ```bash
   npm run dev
   ```

   服务器会监听 `PORT`（默认 `3000`）指定的端口，并自动开放 `/ws` WebSocket 与 `/healthz` 健康检查。

5. **运行测试（可选）**

   ```bash
   npm test
   ```

   测试覆盖 NAT 推断的关键逻辑，建议在改动核心算法后执行。

## WebSocket 协议联调步骤

1. **浏览器创建连接**：

   ```js
   const socket = new WebSocket("ws://localhost:3000/ws");
   ```

2. **RTCPeerConnection 初始化**：

   ```js
   const pc = new RTCPeerConnection({ iceServers: [
     { urls: process.env.STUN_URLS?.split(',') ?? ['stun:stun.l.google.com:19302'] }
   ]});
   ```

3. **收集 ICE 候选**：监听 `icecandidate` 事件，将候选通过 WebSocket 发送至后端：

   ```js
   pc.addEventListener('icecandidate', evt => {
     if (evt.candidate) {
       socket.send(JSON.stringify({
         type: 'candidate',
         candidate: evt.candidate
       }));
     }
   });
   ```

4. **发送 offer**：创建 SDP offer 并通过 WebSocket 发送：

   ```js
   const offer = await pc.createOffer();
   await pc.setLocalDescription(offer);
   socket.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
   ```

5. **处理服务端响应**：

    * 收到 `answer` 时调用 `pc.setRemoteDescription` 完成握手。
    * 等待 `nat_result` 消息，其中包含 `nat_type`、`method`、`evidence.mapping`、`evidence.filtering`、`evidence.srflx_ports` 与 `evidence.relay_only` 等字段。

6. **超时与异常**：若 30 秒内未收到 `nat_result`，检查 STUN 服务可用性、浏览器网络权限或是否被防火墙阻断 UDP。

## 健康检查

服务器提供基础的 HTTP 健康检查接口，可用于部署或监控：

```
GET /healthz -> {"ok": true}
```

## Docker 使用步骤

1. **构建镜像**：

   ```bash
   docker build -t nat-type-pigeon:dev .
   ```

2. **直接运行容器**：

   ```bash
   docker run --rm -p 3000:3000 --env-file .env nat-type-pigeon:dev
   ```

3. **使用 docker compose**：

   ```bash
   docker compose up
   ```

   `docker-compose.yml` 默认仅包含应用容器，如需启用 Redis 可在文件中添加服务或使用扩展配置。

## 版本控制说明

请将生成的 `package-lock.json` 一并提交至仓库，以确保在不同环境中保持一致且可复现的依赖树。这对于 CI 与容器构建尤为重要。

## 自检脚本

运行 `scripts/selfcheck.sh` 可以打印当前启用的 STUN 配置，帮助在执行 RFC5780 探测前验证环境变量，并确认 `STUN_URLS` 已按预期传入容器/进程。
