/**
 * Unit tests for the telemetry / log_event WebSocket handlers.
 */

import { handleTelemetry, handleLogEvent } from '../../../src/websocket/handlers';
import { telemetryService } from '../../../src/services/telemetry.service';
import { clientConnectionManager } from '../../../src/websocket/client-manager';
import { TelemetryMessage, LogEventMessage, ExtendedWebSocket } from '../../../src/websocket/types';
import WebSocket from 'ws';

jest.mock('../../../src/services/telemetry.service', () => ({
  telemetryService: {
    recordTelemetry: jest.fn().mockResolvedValue(undefined),
    recordLogEvent: jest.fn().mockResolvedValue(undefined),
    evaluateThresholds: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../../src/websocket/client-manager');
jest.mock('../../../src/utils/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

const CLIENT_ID = 'a1234567-1111-2222-3333-444455556666';

function makeWs(): ExtendedWebSocket {
  return {
    clientId: CLIENT_ID,
    send: jest.fn(),
    close: jest.fn(),
    readyState: WebSocket.OPEN,
    OPEN: WebSocket.OPEN,
  } as unknown as ExtendedWebSocket;
}

function makeTelemetryMessage(): TelemetryMessage {
  return {
    type: 'telemetry',
    clientId: CLIENT_ID,
    cpu_pct: 42.5,
    mem_used_mb: 1024,
    mem_total_mb: 8192,
    disks: [{ mount: '/', used_bytes: 50, total_bytes: 100 }],
    temps: [{ label: 'cpu', celsius: 55 }],
    net: { ws_reconnects: 0, last_rtt_ms: 30, bytes_dl_total: 5000 },
    mpv: { alive: true, dropped_frames: 0, last_decoder_error: null },
    process: { client_uptime_s: 600, mpv_uptime_s: 590, restart_count: 0 },
    timestamp: Date.now(),
  };
}

describe('handleTelemetry', () => {
  let mockMgr: jest.Mocked<typeof clientConnectionManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMgr = clientConnectionManager as jest.Mocked<typeof clientConnectionManager>;
    mockMgr.isConnected = jest.fn().mockReturnValue(true);
    mockMgr.updateHeartbeat = jest.fn();
  });

  it('persists telemetry and evaluates thresholds for connected client', async () => {
    const msg = makeTelemetryMessage();
    await handleTelemetry(makeWs(), msg);

    expect(telemetryService.recordTelemetry).toHaveBeenCalledTimes(1);
    expect(telemetryService.evaluateThresholds).toHaveBeenCalledTimes(1);
    const [recordedInput] = (telemetryService.recordTelemetry as jest.Mock).mock.calls[0];
    expect(recordedInput).toMatchObject({
      client_id: CLIENT_ID,
      cpu_pct: 42.5,
      mem_used_mb: 1024,
      mem_total_mb: 8192,
    });
    expect(recordedInput.disks).toHaveLength(1);
    expect(mockMgr.updateHeartbeat).toHaveBeenCalledWith(CLIENT_ID);
  });

  it('drops telemetry from unregistered clients', async () => {
    mockMgr.isConnected = jest.fn().mockReturnValue(false);
    await handleTelemetry(makeWs(), makeTelemetryMessage());
    expect(telemetryService.recordTelemetry).not.toHaveBeenCalled();
    expect(telemetryService.evaluateThresholds).not.toHaveBeenCalled();
  });

  it('swallows persistence errors and does not throw', async () => {
    (telemetryService.recordTelemetry as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(handleTelemetry(makeWs(), makeTelemetryMessage())).resolves.toBeUndefined();
  });
});

describe('handleLogEvent', () => {
  let mockMgr: jest.Mocked<typeof clientConnectionManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMgr = clientConnectionManager as jest.Mocked<typeof clientConnectionManager>;
    mockMgr.isConnected = jest.fn().mockReturnValue(true);
  });

  function makeMsg(): LogEventMessage {
    return {
      type: 'log_event',
      clientId: CLIENT_ID,
      level: 'error',
      target: 'montr_client::cache',
      message: 'checksum mismatch',
      timestamp: Date.now(),
    };
  }

  it('persists log events for connected client', async () => {
    await handleLogEvent(makeWs(), makeMsg());
    expect(telemetryService.recordLogEvent).toHaveBeenCalledWith({
      client_id: CLIENT_ID,
      level: 'error',
      target: 'montr_client::cache',
      message: 'checksum mismatch',
    });
  });

  it('drops log events from unregistered clients', async () => {
    mockMgr.isConnected = jest.fn().mockReturnValue(false);
    await handleLogEvent(makeWs(), makeMsg());
    expect(telemetryService.recordLogEvent).not.toHaveBeenCalled();
  });
});
