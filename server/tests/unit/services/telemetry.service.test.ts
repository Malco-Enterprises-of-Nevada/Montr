/**
 * Unit tests for TelemetryService
 *
 * Focuses on the rising-edge threshold evaluator. Persistence is a thin
 * pass-through to the database adapter and is exercised in adapter tests.
 */

import { TelemetryService, TELEMETRY_THRESHOLDS } from '../../../src/services/telemetry.service';
import { getDatabase } from '../../../src/database/connection';
import { notificationService } from '../../../src/services/notification.service';
import { createMockDatabase } from '../../utils/database.mock';
import {
  CreateClientTelemetryInput,
  ClientTelemetryRow,
} from '../../../src/database/types';

jest.mock('../../../src/database/connection');
jest.mock('../../../src/services/notification.service', () => ({
  notificationService: {
    fireEvent: jest.fn().mockResolvedValue(0),
  },
}));

const fireEvent = notificationService.fireEvent as jest.Mock;

const CLIENT_ID = 'a1234567-1111-2222-3333-444455556666';

function makeInput(overrides: Partial<CreateClientTelemetryInput> = {}): CreateClientTelemetryInput {
  return {
    client_id: CLIENT_ID,
    cpu_pct: 10,
    mem_used_mb: 1024,
    mem_total_mb: 8192,
    disks: [{ mount: '/', used_bytes: 50, total_bytes: 100 }],
    temps: [{ label: 'cpu', celsius: 40 }],
    net: { ws_reconnects: 0, last_rtt_ms: null, bytes_dl_total: 0 },
    mpv: { alive: true, dropped_frames: 0, last_decoder_error: null },
    process: { client_uptime_s: 60, mpv_uptime_s: 60, restart_count: 0 },
    ...overrides,
  };
}

function makeRow(overrides: Partial<ClientTelemetryRow> = {}): ClientTelemetryRow {
  return {
    id: 1,
    client_id: CLIENT_ID,
    cpu_pct: 10,
    mem_used_mb: 1024,
    mem_total_mb: 8192,
    disks: [{ mount: '/', used_bytes: 50, total_bytes: 100 }],
    temps: [{ label: 'cpu', celsius: 40 }],
    net: { ws_reconnects: 0, last_rtt_ms: null, bytes_dl_total: 0 },
    mpv: { alive: true, dropped_frames: 0, last_decoder_error: null },
    process: { client_uptime_s: 0, mpv_uptime_s: 0, restart_count: 0 },
    recorded_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

describe('TelemetryService.evaluateThresholds', () => {
  let svc: TelemetryService;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    svc = new TelemetryService();
  });

  describe('disk thresholds', () => {
    it('fires storage_full disk_low_warn on rising edge', async () => {
      const input = makeInput({
        disks: [{ mount: '/', used_bytes: 92, total_bytes: 100 }], // 8% free → warn
      });
      const previous = makeRow({
        disks: [{ mount: '/', used_bytes: 50, total_bytes: 100 }], // 50% free
      });
      mockDb.getClientTelemetryRange.mockResolvedValue([previous, makeRow({ ...input, id: 2 })]);

      await svc.evaluateThresholds(input);

      expect(fireEvent).toHaveBeenCalledTimes(1);
      const [eventType, payload] = fireEvent.mock.calls[0];
      expect(eventType).toBe('storage_full');
      expect(payload).toMatchObject({
        subtype: 'disk_low_warn',
        client_id: CLIENT_ID,
        mount: '/',
      });
    });

    it('fires disk_low_crit when below crit threshold', async () => {
      const input = makeInput({
        disks: [{ mount: '/', used_bytes: 97, total_bytes: 100 }], // 3% free → crit
      });
      mockDb.getClientTelemetryRange.mockResolvedValue([
        makeRow({ disks: [{ mount: '/', used_bytes: 80, total_bytes: 100 }] }),
        makeRow({ id: 2, ...input }),
      ]);

      await svc.evaluateThresholds(input);

      expect(fireEvent).toHaveBeenCalledTimes(1);
      expect(fireEvent.mock.calls[0][1]).toMatchObject({ subtype: 'disk_low_crit' });
    });

    it('does not double-fire when disk stays low across consecutive ticks', async () => {
      const input = makeInput({
        disks: [{ mount: '/', used_bytes: 92, total_bytes: 100 }],
      });
      // Both previous ticks were already below the warn threshold.
      mockDb.getClientTelemetryRange.mockResolvedValue([
        makeRow({ disks: [{ mount: '/', used_bytes: 92, total_bytes: 100 }] }),
        makeRow({ id: 2, disks: [{ mount: '/', used_bytes: 92, total_bytes: 100 }] }),
        makeRow({ id: 3, ...input }),
      ]);

      await svc.evaluateThresholds(input);
      expect(fireEvent).not.toHaveBeenCalled();
    });
  });

  describe('cpu thresholds', () => {
    it('fires cpu_high after sustained high CPU and rising edge', async () => {
      const ticks = TELEMETRY_THRESHOLDS.cpu_warn_consecutive_ticks;
      const previous: ClientTelemetryRow[] = [];
      // One "low" tick before the high run, so we have a rising edge.
      previous.push(makeRow({ cpu_pct: 30 }));
      // Then (ticks - 1) high ticks before the current one.
      for (let i = 0; i < ticks - 1; i++) {
        previous.push(makeRow({ id: i + 2, cpu_pct: 95 }));
      }
      const input = makeInput({ cpu_pct: 95 });
      previous.push(makeRow({ id: 99, ...input }));
      mockDb.getClientTelemetryRange.mockResolvedValue(previous);

      await svc.evaluateThresholds(input);

      expect(fireEvent).toHaveBeenCalled();
      const cpuCall = fireEvent.mock.calls.find(
        (c: unknown[]) => (c[1] as { subtype: string }).subtype === 'cpu_high'
      );
      expect(cpuCall).toBeDefined();
      expect(cpuCall![1]).toMatchObject({ cpu_pct: 95 });
    });

    it('does not fire on a single CPU spike', async () => {
      const input = makeInput({ cpu_pct: 95 });
      mockDb.getClientTelemetryRange.mockResolvedValue([
        makeRow({ cpu_pct: 30 }),
        makeRow({ id: 2, ...input }),
      ]);

      await svc.evaluateThresholds(input);
      expect(fireEvent).not.toHaveBeenCalled();
    });
  });

  describe('temperature thresholds', () => {
    it('fires temp_high on rising edge', async () => {
      const input = makeInput({ temps: [{ label: 'cpu', celsius: 90 }] });
      mockDb.getClientTelemetryRange.mockResolvedValue([
        makeRow({ temps: [{ label: 'cpu', celsius: 50 }] }),
        makeRow({ id: 2, ...input }),
      ]);

      await svc.evaluateThresholds(input);
      expect(fireEvent).toHaveBeenCalledWith(
        'client_error',
        expect.objectContaining({ subtype: 'temp_high', celsius: 90 })
      );
    });

    it('does not fire when temp stays high', async () => {
      const input = makeInput({ temps: [{ label: 'cpu', celsius: 90 }] });
      mockDb.getClientTelemetryRange.mockResolvedValue([
        makeRow({ temps: [{ label: 'cpu', celsius: 90 }] }),
        makeRow({ id: 2, ...input }),
      ]);

      await svc.evaluateThresholds(input);
      expect(fireEvent).not.toHaveBeenCalled();
    });
  });

  describe('mpv dead', () => {
    it('fires mpv_dead on rising edge', async () => {
      const input = makeInput({
        mpv: { alive: false, dropped_frames: 0, last_decoder_error: 'oops' },
      });
      mockDb.getClientTelemetryRange.mockResolvedValue([
        makeRow({ mpv: { alive: true, dropped_frames: 0, last_decoder_error: null } }),
        makeRow({ id: 2, ...input }),
      ]);

      await svc.evaluateThresholds(input);
      expect(fireEvent).toHaveBeenCalledWith(
        'client_error',
        expect.objectContaining({ subtype: 'mpv_dead', last_decoder_error: 'oops' })
      );
    });
  });
});
