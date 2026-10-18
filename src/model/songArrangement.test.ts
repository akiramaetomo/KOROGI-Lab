import { describe, expect, it } from 'vitest';
import type { UserPatternId } from '../audio/types';
import { setSongCellOn, songCell } from './songArrangement';

describe('SONG cells', () => {
  it('reads Frame n as each timbre Pattern n and its In Song flag, and turns only that Pattern on or off', () => {
    const inSong = new Map<string, boolean>([['1:user-3', false]]);
    const engine = {
      getPatternInSong: (id: string, pattern: UserPatternId) => inSong.get(`${id}:${pattern}`) ?? true,
      setPatternInSong: (id: string, pattern: UserPatternId, value: boolean) => { inSong.set(`${id}:${pattern}`, value); },
    };
    expect(songCell(engine, '1', 3)).toEqual({ gate: 'user-3', pitch: 'user-3', on: false });
    expect(songCell(engine, '2', 3)).toEqual({ gate: 'user-3', pitch: 'user-3', on: true });
    setSongCellOn(engine, '1', 3, true); setSongCellOn(engine, '2', 8, false);
    expect(songCell(engine, '1', 3).on).toBe(true);
    expect(songCell(engine, '2', 8)).toEqual({ gate: 'user-8', pitch: 'user-8', on: false });
    expect(songCell(engine, '2', 7).on).toBe(true);
  });
});
