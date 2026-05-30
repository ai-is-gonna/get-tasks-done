import { describe, it, expect } from 'vitest';
import { GTD } from './index.js';
import { GTDEventType, type GTDEvent } from './types.js';

describe('GTD runtime bridge options', () => {
  it('strictSdk option is honored by createTools dispatch seam', async () => {
    const gtd = new GTD({
      projectDir: process.cwd(),
      strictSdk: true,
      allowFallbackToSubprocess: true,
      sessionId: 'test-session',
    });

    const events: GTDEvent[] = [];
    gtd.onEvent((event) => events.push(event));

    await expect(gtd.createTools().exec('nonexistent-command', [])).rejects.toThrow(
      "Strict SDK mode: command 'nonexistent-command' has no native adapter",
    );

    const streamEvent = events.find((event) => event.type === GTDEventType.StreamEvent);
    expect(streamEvent).toBeDefined();
    expect(streamEvent).toMatchObject({
      type: GTDEventType.StreamEvent,
      sessionId: 'test-session',
      event: {
        type: 'query_dispatch',
        command: 'nonexistent-command',
        outcome: 'error',
      },
    });
  });
});
