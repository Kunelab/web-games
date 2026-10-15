import type { CzRoomView, CzView } from 'coronaz-core';

/**
 * Reading the board from a projection.
 *
 * A screen never holds a board: it holds a `CzView`, where the geometry arrives
 * as two strings of boundary codes. These read that for drawing: which cell is
 * where, what is on a cell's side, and which room owns a cell. Where a survivor
 * may move and what it may hit are not worked out here; the server sends them
 * (`me.reach`, `gm.reach`), so a legal move can never look illegal.
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
