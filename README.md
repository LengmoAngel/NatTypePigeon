# NatTypePigeon Backend

This project provides a minimal NAT type detection backend using WebRTC signalling over WebSockets.

## Getting Started

```bash
npm install
npm run dev
```

The server listens on the port configured by `PORT` (default `3000`).

## Environment

Copy `.env.example` to `.env` to customise settings. Default configuration aligns with the agent specification:

```
DISABLE_LIMIT=true
RESULT_PERSIST=false
STUN_URLS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
```

## WebSocket Protocol

* Connect to `ws://localhost:3000/ws` (over TLS in production).
* Send `offer` and `candidate` messages that match the structure shown in `agent.md`.
* Receive `answer` and `nat_result` messages from the backend.

`nat_result` includes the ICE heuristic method outcome along with evidence fields required by the specification.

## Health Check

```
GET /healthz -> {"ok": true}
```

## Docker

Build the container image using the supplied Dockerfile (Node 20 Alpine). A compose file is also available for convenience.

## Version control notes

Keep the generated `package-lock.json` in the repository so installations stay reproducible across environments. The lockfile is required for CI and container builds that rely on deterministic dependency resolution.

## Self Check

Run `scripts/selfcheck.sh` to print the active STUN configuration. This helps verify environment variables before executing RFC5780 probing.
