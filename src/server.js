import http from 'node:http';
import { URL } from 'node:url';

import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'wrtc';

import config from './config.js';
import { logger } from './logger.js';
import { inferNatFromStats, parseIceCandidate } from './nat-infer.js';

const app = express();

if (config.corsOrigins.length > 0) {
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: false
    })
  );
} else {
  app.use(cors());
}

app.use(express.json({ limit: '1mb' }));
app.use(
  morgan('combined', {
    stream: {
      write: (line) => {
        logger.info({ event: 'http.access', msg: line.trim() });
      }
    }
  })
);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function createPeerConnection(sessionId, srflxPorts, ws, context) {
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    ws.send(
      JSON.stringify({
        type: 'candidate',
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      })
    );
  };

  pc.oniceconnectionstatechange = async () => {
    if (typeof logger.debug === 'function') {
      logger.debug({
        event: 'webrtc.state',
        sessionId,
        state: pc.iceConnectionState
      });
    }
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      await sendNatResult(context);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      logger.info({
        event: 'webrtc.connection.state',
        sessionId,
        state: pc.connectionState
      });
    }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    channel.onopen = () => {
      if (typeof logger.debug === 'function') {
        logger.debug({ event: 'webrtc.datachannel.open', sessionId, label: channel.label });
      }
    };
  };

  return pc;
}

async function handleOfferMessage(message, context) {
  const { ws, sessionId, srflxPorts } = context;
  if (context.pc) {
    await context.pc.close();
  }
  context.srflxPorts.clear();
  context.natSent = false;
  const pc = createPeerConnection(sessionId, srflxPorts, ws, context);
  context.pc = pc;
  try {
    const remoteSdp =
      typeof message.sdp === 'string'
        ? { type: 'offer', sdp: message.sdp }
        : message.sdp;
    if (!remoteSdp?.type || !remoteSdp?.sdp) {
      throw new Error('Missing SDP fields');
    }
    await pc.setRemoteDescription(new RTCSessionDescription(remoteSdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(
      JSON.stringify({
        type: 'answer',
        sdp: pc.localDescription
      })
    );
  } catch (error) {
    logger.error({
      event: 'webrtc.offer.error',
      sessionId,
      msg: 'Failed to handle offer',
      error: error.message
    });
    if (context.pc) {
      await context.pc.close();
      context.pc = null;
    }
    ws.send(
      JSON.stringify({
        type: 'error',
        code: 'OFFER_ERROR',
        message: 'Failed to process offer'
      })
    );
  }
}

async function handleCandidateMessage(message, context) {
  if (!context.pc) {
    return;
  }
  try {
    if (!message.candidate) {
      await context.pc.addIceCandidate(null);
      return;
    }
    const parsed = parseIceCandidate(message.candidate);
    if (parsed?.type === 'srflx' && Number.isFinite(parsed.port)) {
      context.srflxPorts.add(parsed.port);
    }
    const init = { candidate: message.candidate };
    if (typeof message.sdpMid === 'string') {
      init.sdpMid = message.sdpMid;
    }
    if (typeof message.sdpMLineIndex === 'number') {
      init.sdpMLineIndex = message.sdpMLineIndex;
    }
    await context.pc.addIceCandidate(new RTCIceCandidate(init));
  } catch (error) {
    logger.error({
      event: 'webrtc.candidate.error',
      sessionId: context.sessionId,
      msg: 'Failed to add ICE candidate',
      error: error.message
    });
    context.ws.send(
      JSON.stringify({
        type: 'error',
        code: 'CANDIDATE_ERROR',
        message: 'Failed to add ICE candidate'
      })
    );
  }
}

async function sendNatResult(context) {
  if (!context.pc || context.natSent) {
    return;
  }
  try {
    const natResult = await inferNatFromStats(context.pc, context.srflxPorts, context.sessionId);
    if (natResult) {
      context.ws.send(JSON.stringify(natResult));
      context.natSent = true;
    }
  } catch (error) {
    logger.error({
      event: 'nat.error',
      msg: 'Failed to infer NAT',
      sessionId: context.sessionId,
      error: error.message
    });
    context.ws.send(
      JSON.stringify({
        type: 'error',
        code: 'NAT_INFER_ERROR',
        message: 'Failed to infer NAT type'
      })
    );
  }
}

wss.on('connection', (ws, req) => {
  const sessionId = uuidv4();
  const srflxPorts = new Set();
  const context = { ws, sessionId, srflxPorts, pc: null, natSent: false };

  logger.info({ event: 'ws.open', sessionId, ip: req.socket.remoteAddress });

  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'BAD_JSON',
          message: 'Message must be valid JSON'
        })
      );
      return;
    }

    switch (message.type) {
      case 'auth':
        ws.send(JSON.stringify({ type: 'auth_ok', ok: true }));
        break;
      case 'offer':
        await handleOfferMessage(message, context);
        break;
      case 'candidate':
        await handleCandidateMessage(message, context);
        break;
      case 'finish':
        await sendNatResult(context);
        break;
      default:
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'UNKNOWN_MESSAGE',
            message: 'Unsupported message type'
          })
        );
    }
  });

  ws.on('close', async () => {
    logger.info({ event: 'ws.close', sessionId });
    if (context.pc) {
      await context.pc.close();
      context.pc = null;
    }
    context.srflxPorts.clear();
    context.natSent = false;
  });

  ws.on('error', (error) => {
    logger.error({ event: 'ws.error', sessionId, error: error.message });
  });
});

server.on('upgrade', (request, socket, head) => {
  try {
    const url = request.url ?? '/';
    const fullUrl = new URL(url, `http://${request.headers.host}`);
    if (fullUrl.pathname !== config.wsPath) {
      socket.destroy();
      return;
    }
  } catch (error) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(config.port, () => {
  logger.info({ event: 'server.start', msg: `HTTP and WS server running on port ${config.port}` });
});

process.on('SIGTERM', () => {
  logger.info({ event: 'server.sigterm', msg: 'Shutting down' });
  wss.clients.forEach((client) => client.close());
  server.close(() => process.exit(0));
});
