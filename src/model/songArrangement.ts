import type { UserPatternId } from '../audio/types';
import { USER_PATTERN_IDS } from './triggerRecording';

/** One SONG grid cell: the Gate and Pitch Pattern a timbre plays in a Frame, and whether it plays or rests there. */
export type SongCell = { gate: UserPatternId; pitch: UserPatternId; on: boolean };

type SongCellSource = { getPatternInSong(id: string, patternId: UserPatternId): boolean };
type SongCellTarget = SongCellSource & { setPatternInSong(id: string, patternId: UserPatternId, inSong: boolean): void };

/**
 * The cell of a timbre in Frame `frame` (1–8). Frame n still holds each timbre's Pattern n and its In Song flag;
 * Song, the grid and the SEQUENCE jump all read cells here so a cell can later name any Gate and Pitch Pattern.
 */
export function songCell(engine: SongCellSource, id: string, frame: number): SongCell {
  const pattern = USER_PATTERN_IDS[frame - 1]!;
  return { gate: pattern, pitch: pattern, on: engine.getPatternInSong(id, pattern) };
}

export function setSongCellOn(engine: SongCellTarget, id: string, frame: number, on: boolean): void {
  engine.setPatternInSong(id, songCell(engine, id, frame).gate, on);
}
