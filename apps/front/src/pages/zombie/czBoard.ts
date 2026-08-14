import type { CzRoomView, CzView } from 'coronaz-core';

/**
 * Reading the board from a projection.
 *
 * The engine has `neighbors(board, room)`, but a screen never holds a board — it
 * holds a `CzView`, where the geometry arrives as two strings of boundary codes.
 * These are the same questions asked of that: which cell is where, what is on a
 * cell's side, and which rooms this one opens onto. Both the phone (tap to move)
 * and the game master's screen (tap to walk a zombie) need the last one, and it
 * must agree with the server's answer exactly or a legal move looks illegal.
 */

export type Side = 'north' | 'east' | 'south' | 'west';

export function cellOf(view: CzView, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) return -1;
  return y * view.width + x;
}

export function cellXY(view: CzView, cell: number): { x: number; y: number } {
  return { x: cell % view.width, y: Math.floor(cell / view.width) };
}

/**
 * The boundary code on one side of a cell: `.` same room, `#` wall, `D` door,
 * `A` arch, `?` withheld by the fog. Off the board reads as wall.
 */
export function edgeAt(view: CzView, x: number, y: number, side: Side): string {
  const here = cellOf(view, x, y);
  if (here === -1) return '#';
  if (side === 'east') return view.edgeRight[here] ?? '#';
  if (side === 'south') return view.edgeDown[here] ?? '#';
  if (side === 'west') {
    const left = cellOf(view, x - 1, y);
    return left === -1 ? '#' : (view.edgeRight[left] ?? '#');
  }
  const up = cellOf(view, x, y - 1);
  return up === -1 ? '#' : (view.edgeDown[up] ?? '#');
}

const indexes = new WeakMap<readonly CzRoomView[], Map<number, CzRoomView>>();

/** Cell index → the room that owns it, cached against the view's room list. */
export function roomIndex(view: CzView): Map<number, CzRoomView> {
  const found = indexes.get(view.rooms);
  if (found) return found;
  const built = new Map<number, CzRoomView>();
  for (const room of view.rooms) {
    for (const cell of room.cells) built.set(cell, room);
  }
  indexes.set(view.rooms, built);
  return built;
}

export function roomOfCell(view: CzView, cell: number): CzRoomView | undefined {
  return roomIndex(view).get(cell);
}

const SIDES: readonly [Side, number, number][] = [
  ['north', 0, -1],
  ['east', 1, 0],
  ['south', 0, 1],
  ['west', -1, 0]
];

/**
 * Rooms one move away: any door or arch on any cell of this room's border.
 *
 * A door reported as `?` is one the fog is hiding, and cannot be walked through
 * from here — which is right, because the server would refuse it too: the
 * projection only withholds boundaries buried between two rooms nobody has seen.
 */
export function neighbourRooms(view: CzView, room: CzRoomView): CzRoomView[] {
  const index = roomIndex(view);
  const seen = new Set<string>();
  const result: CzRoomView[] = [];

  for (const cell of room.cells) {
    const { x, y } = cellXY(view, cell);
    for (const [side, dx, dy] of SIDES) {
      const code = edgeAt(view, x, y, side);
      if (code !== 'D' && code !== 'A') continue;
      const target = cellOf(view, x + dx, y + dy);
      if (target === -1) continue;
      const other = index.get(target);
      if (!other || other.id === room.id || seen.has(other.id)) continue;
      seen.add(other.id);
      result.push(other);
    }
  }

  return result;
}
