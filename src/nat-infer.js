import { logger } from './logger.js';

const NAT_LABELS = {
  OPEN: 'Open Internet (heuristic)',
  NAT1: 'Full Cone (heuristic)',
  NAT2: 'Restricted Cone (heuristic)',
  NAT3: 'Port Restricted Cone (heuristic)',
  NAT4: 'Symmetric (heuristic)',
  UNKNOWN: 'Unknown NAT behaviour'
};

export function parseIceCandidate(candidateString) {
  if (typeof candidateString !== 'string') {
    return null;
  }
  const regex = /candidate:(?<foundation>\S+)\s+\d+\s+(?<protocol>udp|tcp)\s+\d+\s+(?<address>[\dA-Fa-f:.]+)\s+(?<port>\d+)\s+typ\s+(?<type>\w+)/;
  const match = candidateString.match(regex);
  if (!match || !match.groups) {
    return null;
  }
  return {
    foundation: match.groups.foundation,
    protocol: match.groups.protocol,
    address: match.groups.address,
    port: Number.parseInt(match.groups.port, 10),
    type: match.groups.type
  };
}

function sortUniquePorts(ports) {
  return Array.from(new Set(ports)).sort((a, b) => a - b);
}

function describeNatType(remoteCandidateType, srflxPorts) {
  const srflxPortSet = sortUniquePorts(srflxPorts);
  const hasMultipleSrflx = srflxPortSet.length > 1;
  const normalizedType = remoteCandidateType === 'prflx' ? 'srflx' : remoteCandidateType;
  if (normalizedType === 'relay') {
    return {
      nat_type: 'NAT4',
      nat_label: NAT_LABELS.NAT4,
      evidence: {
        mapping: 'ADM',
        filtering: 'APDF',
        srflx_ports: srflxPortSet,
        relay_only: true
      }
    };
  }
  if (hasMultipleSrflx) {
    return {
      nat_type: 'NAT4',
      nat_label: NAT_LABELS.NAT4,
      evidence: {
        mapping: 'ADM',
        filtering: 'APDF',
        srflx_ports: srflxPortSet,
        relay_only: normalizedType === 'relay'
      }
    };
  }
  if (normalizedType === 'host') {
    return {
      nat_type: 'OPEN',
      nat_label: NAT_LABELS.OPEN,
      evidence: {
        mapping: 'EIM',
        filtering: 'EIF',
        srflx_ports: srflxPortSet,
        relay_only: false
      }
    };
  }
  if (normalizedType === 'srflx') {
    return {
      nat_type: 'NAT3',
      nat_label: NAT_LABELS.NAT3,
      evidence: {
        mapping: 'EIM',
        filtering: 'APDF',
        srflx_ports: srflxPortSet,
        relay_only: false
      }
    };
  }
  return {
    nat_type: 'UNKNOWN',
    nat_label: NAT_LABELS.UNKNOWN,
    evidence: {
      mapping: 'UNKNOWN',
      filtering: 'UNKNOWN',
      srflx_ports: srflxPortSet,
      relay_only: normalizedType === 'relay'
    }
  };
}

export async function inferNatFromStats(pc, srflxPorts, sessionId) {
  const stats = await pc.getStats();
  let selectedPair = null;
  const remoteCandidates = new Map();

  stats.forEach((report) => {
    if (report.type === 'remote-candidate') {
      remoteCandidates.set(report.id, report);
    }
    if (report.type === 'candidate-pair') {
      const isSelected = Boolean(report.nominated || report.selected || report.state === 'succeeded');
      if (!isSelected) {
        return;
      }
      if (!selectedPair) {
        selectedPair = report;
        return;
      }
      if ((report.bytesSent ?? 0) + (report.bytesReceived ?? 0) > (selectedPair.bytesSent ?? 0) + (selectedPair.bytesReceived ?? 0)) {
        selectedPair = report;
      }
    }
  });

  if (!selectedPair) {
    logger.warn({
      event: 'nat.infer',
      msg: 'No candidate pair nominated',
      sessionId
    });
    return {
      type: 'nat_result',
      nat_type: 'UNKNOWN',
      nat_label: NAT_LABELS.UNKNOWN,
      remote_selected_type: null,
      srflx_ports: sortUniquePorts(srflxPorts),
      method: 'ICE-HEUR',
      evidence: {
        mapping: 'UNKNOWN',
        filtering: 'UNKNOWN',
        srflx_ports: sortUniquePorts(srflxPorts),
        relay_only: false
      }
    };
  }

  const remoteCandidate = remoteCandidates.get(selectedPair.remoteCandidateId);
  const rawType = remoteCandidate?.candidateType ?? null;
  const normalizedType = rawType === 'prflx' ? 'srflx' : rawType;
  const natSummary = describeNatType(normalizedType, srflxPorts);
  const remoteDetails = {
    ip: remoteCandidate?.ip ?? remoteCandidate?.address ?? null,
    port: remoteCandidate?.port ?? null
  };

  logger.info({
    event: 'nat.infer',
    msg: 'Derived NAT type',
    sessionId,
    details: {
      remoteType: normalizedType,
      srflxPorts: sortUniquePorts(srflxPorts),
      nat: natSummary.nat_type
    }
  });

  return {
    type: 'nat_result',
    nat_type: natSummary.nat_type,
    nat_label: natSummary.nat_label,
    remote_selected_type: normalizedType,
    srflx_ports: sortUniquePorts(srflxPorts),
    method: 'ICE-HEUR',
    evidence: natSummary.evidence,
    external_ip: remoteDetails.ip,
    external_port: remoteDetails.port
  };
}
