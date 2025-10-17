# agent.md — NAT 检测后端实现说明（给编程 AI）

> ⚠️ **规范更新（2025-10-17）——默认启用“无存储/纯返回”模式**
>
> 你只需把 NAT 检测结果 **通过 WebSocket 直接返回给浏览器** 即可；**不需要**把结果落库、也**不需要**实现 `/record_nat_result` 与 `/_results`。
>
> * **必须实现**：`WebSocket /ws`（信令 + NAT 判定回传 `nat_result`）。
> * **可选**：`POST /check_limit`（若 `DISABLE_LIMIT=true`，可不实现）。
> * **不实现**：`POST /record_nat_result`、`GET /_results`（若要保留路由，返回 404/410 即可）。
> * **不引入**：任何持久化（DB/Redis/文件）。
>
> 之前文档中的“存储落地/Prisma/Redis”等都在“未来扩展（非必做）”，**与默认实现解耦**；无需实现即可通过验收。

> 本文是给「编程代理（如：Codex、Code LLM、Cursor、Aider）」的**实施任务书**。请严格按照约定的接口与协议实现，一个命令即可启动并通过验收用例。

---

## 0. 目标 / 成果物

* 实现一个 **Node.js** NAT 类型检测后端，向前端提供与以下端点/协议兼容的最小实现：

  * `POST /check_limit`：额度/频控与令牌分发
  * `WebSocket /ws`：WebRTC 信令 + NAT 推断，返回 `nat_result`
  * `POST /record_nat_result`：上报与存档检测结果
  * `GET /_results`：最近 100 条检测记录（调试用，生产可关闭）
  * `GET /healthz`：健康检查
* 提供**可运行项目**（源码 + 脚本）：`npm i && npm run dev` 即可启动；
* 提供 **Dockerfile** 与 **docker-compose.yml**（含 Redis 可选），一条命令 `docker compose up` 可跑通；
* 通过**单元测试**与**端到端验收用例**。

> 注：精确区分 NAT2/NAT3 需 RFC5780/多源回探，本实现采用工程可行的启发式（详见 §4）。

---

## 1. 技术栈与目录结构

* Node.js ≥ 18（ESM 模块）
* 依赖：`express`、`ws`、`wrtc`、`cors`、`morgan`、`dotenv`、`uuid`、`pino`（或等价 JSON 日志库）
* 可选：`ioredis`（或 `redis` 官方 SDK）用于分布式额度/令牌存储（若未提供 Redis，则默认内存版）

```
nat-backend/
├─ package.json
├─ Dockerfile
├─ docker-compose.yml
├─ .env.example
├─ src/
│  ├─ server.js            # 入口：HTTP + WS + 路由
│  ├─ nat-infer.js         # NAT 推断（启发式）
│  ├─ memory-store.js      # 内存存储（IP 额度/令牌/结果）
│  ├─ redis-store.js       # 可选：Redis 实现（接口与 memory-store 对齐）
│  ├─ schemas.js           # JSON Schema / zod 校验（如选）
│  └─ logger.js            # 结构化日志
├─ tests/
│  ├─ nat-infer.test.js
│  └─ e2e.ws.test.js       # 可用 mock wrtc/或集成测试
└─ README.md
```

---

## 2. .env 配置（环境变量）

```dotenv
PORT=3000
WS_PATH=/ws
STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
# ✅ 默认无配额控制：直接允许，亦无需 token
DISABLE_LIMIT=true
# ✅ 默认无持久化：不写入任何数据库/Redis/文件
RESULT_PERSIST=false
# CORS 可按需放开本机调试域名
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
LOG_LEVEL=info
```

> 若 `DISABLE_LIMIT=true`：可以完全不实现 `/check_limit`；前端无需 `auth`。
> 若后续要开启限额，可把 `DISABLE_LIMIT=false`，再实现一个简单的**内存计数**或 **JWT 无状态令牌**（参考 §12）。

```dotenv
PORT=3000
WS_PATH=/ws
STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
DAILY_LIMIT=5
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
LOG_LEVEL=info
USE_REDIS=false
REDIS_URL=redis://localhost:6379
```

> 要求：支持 `.env`，并允许用环境变量覆盖。

---

## 3. HTTP 接口规范

> **无存储/默认模式：仅 WebSocket 即可**。本节的 REST 路由均为**可选**，默认可以全部不实现。

### 3.1 （可选）POST /check_limit

* 当 `DISABLE_LIMIT=true` 时可移除；若实现，语义同原文。

### 3.2 （默认不实现）POST /record_nat_result

* 若你仍想保留路由占位，请直接返回 `410 Gone`。

### 3.3 （默认不实现）GET /_results

* 开发调试用；默认不提供。

### 3.4 GET /healthz（建议保留）

* 返回（200）：`{ "ok": true }`

---

## 4. WebSocket 协议（/ws）

* 路径：`WS_PATH`（默认 `/ws`）；升级时校验路径，不匹配直接 `socket.destroy()`。
* 消息均为 UTF-8 JSON 文本。未通过 JSON 解析或字段缺失时，服务器返回：

```json
{ "type": "error", "code": "BAD_MESSAGE", "message": "..." }
```

### 4.1 消息类型（客户端 → 服务器）

* `auth`（可选）：

```json
{ "type": "auth", "token": "来自 /check_limit 的 token" }
```

* `offer`（必需）：

```json
{ "type": "offer", "sdp": { "type": "offer", "sdp": "..." } }
```

* `candidate`（0..N 次）：

```json
{ "type": "candidate", "candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0 }
```

* `finish`（可选）：通知服务端尽快给出当前推断并结束。

### 4.2 消息类型（服务器 → 客户端）

* `auth_ok`：`{ "type": "auth_ok", "ok": true }`
* `answer`：`{ "type": "answer", "sdp": { "type": "answer", "sdp": "..." } }`
* `nat_result`：

```json
{
  "type": "nat_result",
  "nat_type": "NAT3",                     // NAT1..NAT4 或 OPEN/UNKNOWN
  "nat_label": "Port Restricted Cone (heuristic)",
  "remote_selected_type": "srflx",        // host | srflx | relay | null
  "srflx_ports": [63845, 63846]            // 客户端上报的 srflx 端口集合
}
```

* `error`：`{ "type": "error", "code": "...", "message": "..." }`

### 4.3 NAT 类型映射

* `NAT1 = Full Cone`
* `NAT2 = Restricted Cone`
* `NAT3 = Port Restricted Cone`
* `NAT4 = Symmetric`
* `OPEN = Open Internet / Full Cone 倾向`
* `UNKNOWN`

### 4.4 推断规则（启发式）

1. 若选定候选对（`getStats()` → `candidate-pair`）的 **remote.candidateType = relay** ⇒ `NAT4`（严格/对称/被防火墙，需中继）。
2. 若客户端上报的 **srflx** 候选端口集合大小 > 1（对不同目的产生不同映射端口） ⇒ `NAT4`（对称特征）。
3. 若 `remote.candidateType = host` ⇒ `OPEN`（或 Full Cone 倾向）。
4. 若存在 `srflx` 且成功直连 ⇒ `NAT3`（端口受限锥形，启发式）。

> 注：NAT1/NAT2 与 NAT3 的精准划分需要多源端口回探或 RFC5780。可在后续版本扩展。

---

## 5. 关键实现要求

* **WebRTC 服务端**使用 `wrtc.RTCPeerConnection`，`iceServers` 来自 `STUN_URLS`。
* 解析客户端 `candidate.candidate` 字符串，抽取 `srflx` 端口（正则即可）。
* 在 `iceconnectionstate` 进入 `connected/completed` 后：

  * 调用 `pc.getStats()`，找到 **nominated 或 succeeded** 的 `candidate-pair`；
  * 读取 `remote-candidate.candidateType`；
  * 按 §4.4 推断并发送 `nat_result`。
* **额度与令牌**：

  * 额度按 **IP/天** 计数；默认 5 次/天；
  * `token` 与 IP 绑定，过期 15 分钟；
  * 存储接口抽象（内存/Redis 可互换）。
* **安全**：

  * CORS 允许名单来自 `CORS_ORIGINS`；若为空，开发环境放开，生产必须配置；
  * 限制 WS 升级路径；
  * 关闭/保护 `/_results` 于生产；
  * 不要把完整 SDP/候选写入日志，仅记录摘要。
* **日志**：JSON 结构化日志，字段含 `ts, level, msg, ip, route, event, details`。

---

## 6. JSON Schema / TypeScript 类型（可选）

```ts
export type WsClientMsg =
  | { type: 'auth'; token: string }
  | { type: 'offer'; sdp: { type: 'offer'; sdp: string } }
  | { type: 'candidate'; candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  | { type: 'finish' };

export type WsServerMsg =
  | { type: 'auth_ok'; ok: boolean }
  | { type: 'answer'; sdp: { type: 'answer'; sdp: string } }
  | { type: 'nat_result'; nat_type: string; nat_label: string; remote_selected_type: 'host'|'srflx'|'relay'|null; srflx_ports: number[] }
  | { type: 'error'; code: string; message: string };
```

---

## 7. 示例：浏览器前端对接（最小可运行片段）

```html
<script>
(async () => {
  const ws = new WebSocket('wss://YOUR_HOST/ws');
  const pc = new RTCPeerConnection({ iceServers: [ { urls: ['stun:stun.l.google.com:19302'] } ] });
  pc.createDataChannel('t');
  ws.onopen = () => {
    // 可选：拿到 /check_limit 的 token 后：
    // ws.send(JSON.stringify({ type: 'auth', token: '...' }));
  };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'answer') {
      await pc.setRemoteDescription(msg.sdp);
    }
    if (msg.type === 'nat_result') {
      console.log('NAT:', msg);
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }));
    } else {
      ws.send(JSON.stringify({ type: 'finish' }));
    }
  };
  const offer = await pc.createOffer({ iceRestart: true });
  await pc.setLocalDescription(offer);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
  });
})();
</script>
```

---

## 8. cURL 示例

```bash
# 额度/令牌
curl -s -X POST http://localhost:3000/check_limit | jq

# 记录结果
curl -s -X POST http://localhost:3000/record_nat_result \
  -H 'Content-Type: application/json' \
  -d '{"token":"...","nat_type":"NAT3","external_ip":"1.2.3.4","external_port":63845,"detail":{"remote_selected_type":"srflx","srflx_ports":[63845]}}' | jq

# 查看最近结果
curl -s http://localhost:3000/_results | jq
```

---

## 9. Docker 与 Compose

**Dockerfile**（要求：使用 distroless 或 slim 基础镜像，暴露 3000）

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

**docker-compose.yml**（含可选 Redis）

```yaml
version: '3.8'
services:
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      - PORT=3000
      - WS_PATH=/ws
      - STUN_URLS=stun:stun.l.google.com:19302
      - DAILY_LIMIT=5
      - CORS_ORIGINS=http://localhost:5173
      - USE_REDIS=false
    depends_on: []
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```

---

## 10. 测试计划

### 10.1 单元测试（nat-infer）

* 输入：`remote_selected_type='relay'` → 输出 `NAT4`
* 输入：`srflx_ports={12345,23456}` → 输出 `NAT4`
* 输入：`remote_selected_type='host'` → 输出 `OPEN`
* 输入：`remote_selected_type='srflx' && srflx_ports={63845}` → 输出 `NAT3`

### 10.2 端到端（手工）

* 启动后端，打开前端最小片段：

  * 能收到 `answer`；
  * 最终收到 `nat_result`；
  * `/_results` 能看到刚刚的记录。

### 10.3 端到端（自动化，选做）

* 使用 `playwright`/`puppeteer` 启动无头浏览器，注入前端片段，与本地后端交互，断言收到 `nat_result`。

---

## 11. 验收标准（Definition of Done）

* 启动：`npm i && npm run dev` 后 `GET /healthz` 返回 `{ok:true}`；
* 浏览器端使用 §7 的最小片段：**30 秒内**通过 WS 收到 `nat_result`；
* **不创建任何持久化资源**（无 DB/Redis/文件写入）；
* Docker 构建成功，`docker compose up`（若提供）能启动并通过上述两项；
* 代码通过基础 lint（可选）。

---

## 12. 未来扩展（非必做）

* IP 限速：`rate-limiter-flexible`；

---

## 13. 精确 NAT1~NAT4 检测（RFC5780 模式）

> **动机**：仅靠浏览器 WebRTC/ICE 无法对 NAT 过滤行为做完整区分（尤其 NAT2 vs NAT3）。为实现**可验证**的 NAT 分型（NAT1: Full Cone, NAT2: Restricted Cone, NAT3: Port-Restricted Cone, NAT4: Symmetric），需要引入 **RFC5780** 的 STUN 探测序列。

### 13.1 组件

* **RFC5780 STUN 服务器**：推荐 `coturn`，需开启 `rfc5780` 并提供**同协议族**下的备用地址（不同 IP 或 不同端口）。
* **NAT-Prober 子模块（Node）**：后端通过 UDP `dgram` + STUN 客户端（可用 `nodertc/stun`）向上述 STUN 发起 **Binding** / **CHANGE-REQUEST** / **Other-Address** 探测，计算映射与过滤行为。
* **编排器**：现有 WebSocket 会话用于把最终 `nat_type` 回传给前端；WebRTC 仍用于收集 `srflx/relay` 作为辅助证据。

### 13.2 coturn 最小配置（示例）

在 `turnserver.conf` 中：

```
# 基础监听（IPv4 示例）
listening-ip=203.0.113.10
# 可选：第二地址（同族），或仅使用备用端口
# listening-ip=203.0.113.11

# 端口：3478 + 备用端口（RFC5780 用于 CHANGE-REQUEST 测试）
listening-port=3478
alt-listening-port=3479

# 开启 RFC5780 行为发现
rfc5780

# 其他常规建议
fingerprint
no-stdout-log
# 生产务必做访问控制/限速、证书、认证等
```

> 若只有单 IP，可用 `alt-listening-port` 充当“不同源端口”；若有两张公网 IP，优先用两 IP + 端口的组合，以便做 **change-ip** 与 **change-port** 双测试。

### 13.3 探测算法（客户端=后端 NAT-Prober，对象=用户 NAT）

> 术语：
>
> * **MAPPED-ADDRESS/XOR-MAPPED-ADDRESS**：STUN 返回的公网映射 (IP:Port)
> * **OTHER-ADDRESS / RESPONSE-ORIGIN**：RFC5780 提供的备用地址信息
> * **CHANGE-REQUEST**：要求服务端改用“另一 IP/端口”回复

**Step A — 基本映射**

1. 向 `S1(A1:3478)` 发送 `Binding Request`，得 `M1 = (IPa,Portx)`。
2. 向 `S1(A1:3479)`（或 `OTHER-ADDRESS` 指示的 `A2:port`）再发一次，得 `M2`。

   * 若 `M1.port == M2.port`（且 IP 相同）⇒ **Endpoint-Independent Mapping**（锥形族）。
   * 若端口随目的端口/地址改变 ⇒ **Address/Port-Dependent Mapping**（对称特征）。

**Step B — 过滤行为（CHANGE-REQUEST）**
3. 针对 `S1(A1:3478)` 再发 `Binding + CHANGE-REQUEST(change-port)`，预期服务端从 `A1:3479` 回复。

* 能收到 ⇒ **Endpoint-Independent Filtering**（Full Cone 倾向）。
* 收不到 ⇒ 继续。

4. 再发 `Binding + CHANGE-REQUEST(change-ip, change-port)`，预期从 `A2:3479` 回复。

   * 若仅当 **同 IP** 不同端口能收、跨 IP 收不到 ⇒ **Address-Dependent Filtering**（NAT2）。
   * 若必须 **同 IP 且同端口** 才能收 ⇒ **Address-and-Port-Dependent Filtering**（NAT3）。

**Step C — 归类**

* `Mapping` 为 **依赖目的（port/ip）** ⇒ `NAT4: Symmetric`。
* 否则（EIM）依据 `Filtering`：

  * EIF ⇒ `NAT1: Full Cone`
  * ADF ⇒ `NAT2: Restricted Cone`
  * APDF ⇒ `NAT3: Port-Restricted Cone`

### 13.4 Node 实现草案

> 可直接让编码代理使用：

```ts
// src/rfc5780/prober.ts（示意）
import dgram from 'node:dgram';
import { StunClient, buildBinding, parseResponse, withChangeRequest } from './stun78x';

export async function probe5780(opts:{primary:string; alt?:string; timeout?:number}){
  const { primary, alt, timeout=800 } = opts; // e.g. '203.0.113.10:3478', '203.0.113.10:3479' or '203.0.113.11:3478'
  const cli = new StunClient(dgram.createSocket('udp4'));

  // A: 映射
  const r1 = await cli.tx(buildBinding(), primary, { timeout });
  const M1 = parseResponse(r1); // xorMapped {ip, port}, otherAddress {ip, port}
  const altEP = alt || M1.otherAddress?.udp || /* fallback */ primary.replace(':3478', ':3479');
  const r2 = await cli.tx(buildBinding(), altEP, { timeout });
  const M2 = parseResponse(r2);
  const mappingSym = (M1.xorMapped.port !== M2.xorMapped.port || M1.xorMapped.ip !== M2.xorMapped.ip);

  // B: 过滤
  let filt: 'EIF'|'ADF'|'APDF'|'UNKNOWN' = 'UNKNOWN';
  const r3 = await cli.tx(withChangeRequest({ changePort: true }), primary, { timeout });
  if (r3.ok) filt = 'EIF'; else {
    const r4 = await cli.tx(withChangeRequest({ changeIP: true, changePort: true }), primary, { timeout });
    if (r4.ok) filt = 'ADF';
    else filt = 'APDF';
  }

  // C: 归类
  if (mappingSym) return { nat: 'NAT4', mapping: 'ADM/APDM', filtering: filt };
  if (filt === 'EIF') return { nat: 'NAT1', mapping: 'EIM', filtering: 'EIF' };
  if (filt === 'ADF') return { nat: 'NAT2', mapping: 'EIM', filtering: 'ADF' };
  if (filt === 'APDF') return { nat: 'NAT3', mapping: 'EIM', filtering: 'APDF' };
  return { nat: 'UNKNOWN', mapping: 'UNKNOWN', filtering: 'UNKNOWN' };
}
```

> 说明：`stun78x` 是建议实现的极简 STUN 工具集（或采用开源库 `nodertc/stun`），需支持：
>
> * 解析 `XOR-MAPPED-ADDRESS`、`OTHER-ADDRESS` / `RESPONSE-ORIGIN`；
> * 组装 `CHANGE-REQUEST` 属性；
> * 事务重传与超时控制（RFC5389）。

### 13.5 与浏览器 WebRTC 的协同

* 在 WS 会话中先运行 **RFC5780 探测**（200–800ms 内可得出结论）。
* 并行发起 WebRTC ICE：

  * 收集 `srflx/relay` 作为旁证；
  * 若 RFC5780 失败（比如运营商屏蔽 UDP/3478），则回退到 **ICE 启发式**（§4.4）。
* 统一产出：`nat_type`（NAT1..NAT4/OPEN/UNKNOWN）+ 证据（mapping/filtering、srflx 端口集、是否 relay-only）。

### 13.6 验收补充（RFC5780 模式）

* 提供 `scripts/selfcheck.sh`：

  * 检查 coturn `rfc5780` 是否生效（探测 OTHER-ADDRESS 是否返回）。
  * 依次跑 Step A/B/C，打印结论与中间证据。
* 在 `/_results` 存档中新增字段：`mapping`, `filtering`, `method: 'RFC5780'|'ICE-HEUR'`。

### 13.7 失败与降级策略

* 若 UDP 完全不可用或 STUN 被拦截：直接标记 `NAT4 (Relay required)`，并提示走 TURN。
* 若仅 `change-ip` 不可用（单 IP 服务器）：以 `change-port` 测试推断（可能把 NAT2 判为 NAT3），并在 `detail.warn` 给出不确定性。

### 13.8 安全与放大风险

* 开启 `rfc5780` 会引入 **STUN 放大**面风险，务必：

  * 对来源做 **ACL/白名单** 或速率限制；
  * 仅对你的 API 后端可达（内网/专线）开放 RFC5780 端口；
  * 打开 `fingerprint` 与 `--no-tcp-relay` 等保守选项；
  * 监控 QPS 与响应大小。

---

## 14. 最终输出格式（含 RFC5780 字段）

```json
{
  "nat_type": "NAT3",
  "method": "RFC5780",
  "evidence": {
    "mapping": "EIM",
    "filtering": "APDF",
    "srflx_ports": [63845,63846],
    "relay_only": false
  },
  "external_ip": "203.0.113.25",
  "external_port": 63845
}
```

---

## 15. 兼容性与备选

* 如无法部署 coturn，可采用 `stuntman` 提供 RFC5780 端口对（变更 IP/端口），或自建简化 STUN 回显器（双口/双 IP）。
* 若只允许浏览器，不允许任何客户端原生 UDP：保留 §4.4 启发式，并在 UI 明示“基础判定（可能把 NAT2/3 合并为 NAT3）”。
