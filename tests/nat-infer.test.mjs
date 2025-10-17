import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIceCandidate, inferNatFromStats } from '../src/nat-infer.js';

test('parseIceCandidate extracts core fields', () => {
  const candidate = 'candidate:842163049 1 udp 1677729535 203.0.113.10 54400 typ srflx raddr 0.0.0.0 rport 0';
  const parsed = parseIceCandidate(candidate);
  assert.ok(parsed);
  assert.equal(parsed.protocol, 'udp');
  assert.equal(parsed.address, '203.0.113.10');
  assert.equal(parsed.port, 54400);
  assert.equal(parsed.type, 'srflx');
});

test('parseIceCandidate returns null for malformed input', () => {
  const parsed = parseIceCandidate('invalid-candidate-line');
  assert.equal(parsed, null);
});

test('inferNatFromStats falls back to UNKNOWN when no selected pair', async () => {
  const stats = new Map([
    ['rc1', { id: 'rc1', type: 'remote-candidate', candidateType: 'srflx', ip: '198.51.100.4', port: 60000 }],
    [
      'cp1',
      {
        id: 'cp1',
        type: 'candidate-pair',
        remoteCandidateId: 'rc1',
        state: 'in-progress',
        nominated: false,
        bytesSent: 0,
        bytesReceived: 0
      }
    ]
  ]);
  const fakePc = { getStats: async () => stats };
  const result = await inferNatFromStats(fakePc, [], 'session-unknown');
  assert.equal(result.nat_type, 'UNKNOWN');
  assert.equal(result.method, 'ICE-HEUR');
  assert.deepEqual(result.srflx_ports, []);
});

test('inferNatFromStats returns OPEN for host candidates', async () => {
  const stats = new Map([
    ['rc1', { id: 'rc1', type: 'remote-candidate', candidateType: 'host', ip: '203.0.113.20', port: 55000 }],
    [
      'cp1',
      {
        id: 'cp1',
        type: 'candidate-pair',
        remoteCandidateId: 'rc1',
        state: 'succeeded',
        nominated: true,
        bytesSent: 1234,
        bytesReceived: 4321
      }
    ]
  ]);
  const fakePc = { getStats: async () => stats };
  const result = await inferNatFromStats(fakePc, [55000], 'session-open');
  assert.equal(result.nat_type, 'OPEN');
  assert.equal(result.remote_selected_type, 'host');
  assert.equal(result.external_ip, '203.0.113.20');
  assert.equal(result.external_port, 55000);
  assert.deepEqual(result.evidence.srflx_ports, [55000]);
});

test('inferNatFromStats marks NAT4 when multiple srflx ports observed', async () => {
  const stats = new Map([
    ['rc1', { id: 'rc1', type: 'remote-candidate', candidateType: 'srflx', ip: '203.0.113.30', port: 61000 }],
    [
      'cp1',
      {
        id: 'cp1',
        type: 'candidate-pair',
        remoteCandidateId: 'rc1',
        state: 'succeeded',
        nominated: true,
        bytesSent: 4000,
        bytesReceived: 5000
      }
    ]
  ]);
  const fakePc = { getStats: async () => stats };
  const result = await inferNatFromStats(fakePc, [61000, 62000], 'session-nat4');
  assert.equal(result.nat_type, 'NAT4');
  assert.equal(result.remote_selected_type, 'srflx');
  assert.equal(result.evidence.mapping, 'ADM');
  assert.equal(result.evidence.filtering, 'APDF');
  assert.deepEqual(result.evidence.srflx_ports, [61000, 62000]);
});
