# NatTypePigeon 后端

[English README](README.md)

本项目提供一个使用 WebRTC 通过 WebSocket 进行信令的最小 NAT 类型检测后端。

## 快速开始

```bash
npm install
npm run dev
```

服务器会监听 `PORT`（默认 `3000`）指定的端口。

## 环境配置

复制 `.env.example` 为 `.env` 以便根据需要覆盖变量。默认配置与 `agent.md` 中的规范保持一致：

```
DISABLE_LIMIT=true
RESULT_PERSIST=false
STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
```

## WebSocket 协议

* 连接到 `ws://localhost:3000/ws`（生产环境建议使用 TLS）。
* 按照 `agent.md` 中给出的结构发送 `offer` 与 `candidate` 消息。
* 接收来自后端的 `answer` 与 `nat_result` 消息。

`nat_result` 会返回基于 ICE 启发式的判定结果，以及规范要求的证据字段。

## 健康检查

```
GET /healthz -> {"ok": true}
```

## Docker

使用提供的 Dockerfile（基于 Node 20 Alpine）来构建镜像，同时也提供了一个方便使用的 docker-compose 配置。

## 版本控制说明

请将生成的 `package-lock.json` 一并提交至仓库，以确保在不同环境中保持一致且可复现的依赖树。这对于 CI 与容器构建尤为重要。

## 自检脚本

运行 `scripts/selfcheck.sh` 可以打印当前启用的 STUN 配置，帮助在执行 RFC5780 探测前验证环境变量。
