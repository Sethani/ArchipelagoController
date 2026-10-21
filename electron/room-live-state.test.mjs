import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRoomLiveState, safeLine } = require('./room-live-state.cjs');

describe('Controller room live state', () => {
  it('tracks bounded public player activity without exposing credentials', () => {
    let tick = 0;
    const state = createRoomLiveState([{ slot: 1, name: 'Sethiduck_MC', game: 'Minecraft' }], () => `2026-10-20T10:00:0${tick++}.000Z`);
    state.update('Sethiduck_MC joined the game');
    state.update('Sethiduck_MC checked Advancement: Stone Age');
    state.update('Sethiduck_MC checked Advancement: Stone Age');
    state.update('[Hint]: Sethiduck_MC was hinted Diamond at Village');
    state.update('Sethiduck_MC has completed their goal');
    const result = state.snapshot();
    expect(result.players[0]).toMatchObject({ connected: true, checksSeen: 1, status: 'Finished' });
    expect(result.hints).toHaveLength(1);
    expect(result.unresolvedHints).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual(['goal', 'hint', 'check', 'check', 'connection']);
  });

  it('redacts room and admin passwords', () => {
    expect(safeLine('!admin login hunter2')).toBe('!admin login [redacted]');
    expect(safeLine('room_password: secret')).toBe('room_password: [redacted]');
  });
});
