import { describe, expect, it } from 'vitest';
import { parseLabSession } from './model/documents';
import { DEMO_SESSIONS } from './demoSessions';

describe('bundled Demo Sessions', () => {
  it('migrates three bundled eight-slot sessions to current session-v16 documents', () => {
    expect(DEMO_SESSIONS.map(demo => demo.name)).toEqual(['Akino-mushi', 'Filter-Acid1', 'Filter-Acid2']);
    for (const demo of DEMO_SESSIONS) {
      const session = parseLabSession(demo.source);
      expect(session.formatVersion).toBe('KOROGI-Lab/session-v16');
      expect(session.channels).toHaveLength(8);
      expect(session.name).toBe(demo.name);
    }
  });
});

