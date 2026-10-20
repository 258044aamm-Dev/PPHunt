/**
 * SAD-369 D10 — the drift line's move to the service worker.
 *
 * `logDriftReport` keeps its emission points and its byte-identical line;
 * only the destination changes: a transport set by the content script routes
 * the payload to the worker, and `null` restores the page-console default
 * (tests, non-extension contexts). The worker-side print is covered in
 * `collection-diagnostics-worker.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AmazonDriftTelemetry,
  formatDriftLogLine,
  logDriftReport,
  setDriftTransport,
  type DriftLogPayload,
} from '@/engines/amazon/scraper/drift-telemetry';
import { setDiagnosticsEnabled } from '@/engines/amazon/utils/diagnostics-flag';

function telemetryWithOneCard(): AmazonDriftTelemetry {
  const telemetry = new AmazonDriftTelemetry();
  telemetry.recordCardExtraction({ asin: 'tier2_semantic' });
  return telemetry;
}

afterEach(() => {
  setDriftTransport(null);
  void setDiagnosticsEnabled(false, {});
});

describe('SAD-369 D10: drift line routing', () => {
  it('routes the payload to the transport and keeps the page console quiet', () => {
    void setDiagnosticsEnabled(true, {});
    const sent: DriftLogPayload[] = [];
    setDriftTransport((payload) => sent.push(payload));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      logDriftReport(telemetryWithOneCard(), 'search-results');

      expect(sent).toHaveLength(1);
      expect(sent[0]!.stage).toBe('search-results');
      expect(sent[0]!.report.cardsInspected).toBe(1);
      expect(sent[0]!.report.cardsExtracted).toBe(1);
      // The page console must stay quiet once the worker owns the line.
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it('prints the byte-identical line on the default transport', () => {
    void setDiagnosticsEnabled(true, {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      const telemetry = telemetryWithOneCard();
      logDriftReport(telemetry, 'category-page');

      const tag = '[PPHunt][Amazon][Diagnostics] drift ';
      const lines = info.mock.calls
        .map((call) => call[0])
        .filter(
          (first): first is string =>
            typeof first === 'string' && first.startsWith(tag),
        );
      expect(lines).toHaveLength(1);
      // The formatter and the default transport agree — the same string the
      // worker will print (D10 changed the console, not the line).
      expect(lines[0]).toBe(
        formatDriftLogLine({
          stage: 'category-page',
          report: telemetry.getReport(),
        }),
      );
      const parsed = JSON.parse(lines[0]!.slice(tag.length)) as Record<
        string,
        unknown
      >;
      expect(parsed).toMatchObject({
        stage: 'category-page',
        cardsInspected: 1,
        cardsExtracted: 1,
      });
    } finally {
      info.mockRestore();
    }
  });

  it('stays silent while the switch is off — on both transports', () => {
    void setDiagnosticsEnabled(false, {});
    const sent: DriftLogPayload[] = [];
    setDriftTransport((payload) => sent.push(payload));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      logDriftReport(telemetryWithOneCard(), 'search-results');
      expect(sent).toHaveLength(0);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it('a throwing transport never breaks the parse caller', () => {
    void setDiagnosticsEnabled(true, {});
    setDriftTransport(() => {
      throw new Error('transport is gone');
    });

    expect(() =>
      logDriftReport(telemetryWithOneCard(), 'search-results'),
    ).not.toThrow();
  });
});
