/**
 * Turns a generated square into a game sprite: cut out, trimmed, scaled.
 *
 *   node scripts/art-cutout.mjs <source dir> <destination dir> [--max 256]
 *
 * ComfyUI writes a 512x512 RGB image with the subject sitting on a flat dark
 * backdrop and no alpha channel at all. Something has to remove that backdrop,
 * and *how* it is removed is the difference between a sprite and a smear.
 *
 * The set already in the repo was cut by a matting model, and it shows: 17% of
 * the pixels in `house-village-day` carry partial alpha, spread evenly across
 * every band from 1 to 254. That is not an antialiased edge — an edge is a
 * one-pixel ring and lands at 2% — it is the *body* of the house rendered
 * half see-through, which is why the town looked like it was made of tracing
 * paper. The tombstone was worse: 12.7% of it fully opaque, 26.7% partial.
 *
 * So this does the plainest possible thing instead, and the plainest thing is
 * the right thing when the backdrop is flat:
 *
 *  - **Flood from the border**, rather than keying every pixel that matches the
 *    backdrop colour. A dark roof or a shadow under an eave is the same grey as
 *    the backdrop and is not the backdrop; what makes it part of the subject is
 *    that you cannot reach it from outside without crossing the subject.
 *  - **Hard alpha, then erode one pixel.** Every pixel on the boundary has the
 *    backdrop mixed into it, so keeping them leaves a dark fringe that reads as
 *    a drop shadow nobody asked for. Dropping that ring costs a pixel of subject
 *    at 512 and nothing at all once the sprite is drawn 72 wide.
 *  - **Trim, then scale with a box filter.** The antialiasing the hard edge
 *    lacks comes back for free on the way down, and it comes back *correct*,
 *    because it is computed against real neighbouring pixels rather than
 *    guessed by a model.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* --------------------------------- PNG I/O -------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Reads an 8-bit PNG, RGB or RGBA, into one flat RGBA buffer. */
function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colour = buf[25];
  if (depth !== 8 || (colour !== 2 && colour !== 6)) {
    throw new Error(`${file}: only 8-bit RGB or RGBA (got depth ${depth}, type ${colour})`);
  }
  const channels = colour === 6 ? 4 : 3;

  const parts = [];
  let at = 8;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') parts.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));

  const stride = width * channels;
  const flat = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const value = raw[pos + x];
      const left = x >= channels ? flat[y * stride + x - channels] : 0;
      const up = y > 0 ? flat[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? flat[(y - 1) * stride + x - channels] : 0;
      let recon;
      if (filter === 0) recon = value;
      else if (filter === 1) recon = value + left;
      else if (filter === 2) recon = value + up;
      else if (filter === 3) recon = value + ((left + up) >> 1);
      else {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        recon = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      flat[y * stride + x] = recon & 0xff;
    }
    pos += stride;
  }

  if (channels === 4) return { width, height, data: flat };
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    rgba[index * 4] = flat[index * 3];
    rgba[index * 4 + 1] = flat[index * 3 + 1];
    rgba[index * 4 + 2] = flat[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

function writePng(file, { width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ])
  );
}

/* -------------------------------- the cut --------------------------------- */

/**
 * How far from the backdrop colour a pixel may sit and still be backdrop.
 *
 * Summed across the three channels, so 60 is twenty levels per channel. The
 * generated backdrops vary by about eight levels corner to corner, which is
 * the gradient a diffusion model leaves behind when asked for a flat one, so
 * the threshold has to clear that with room to spare.
 *
 * Tried in order, loosest first, because there is no single right answer and
 * the wrong one is catastrophic rather than untidy. A bright house on this dark
 * backdrop wants the loose end of the range: anything tighter leaves a collar of
 * backdrop around the eaves. A *night* house is painted in the same greys as the
 * backdrop it stands on, and at 60 the flood walks straight through the front
 * wall and hollows the building out — measured, and the mask came back looking
 * like lace. See `cutBackdrop` for how one gets chosen.
 */
const TOLERANCES = [60, 46, 36, 28, 22, 17, 13, 10, 7];

/** The backdrop colour, taken from the border rather than assumed. */
function backdropOf({ width, height, data }) {
  let red = 0;
  let green = 0;
  let blue = 0;
  let seen = 0;
  const sample = (x, y) => {
    const at = (y * width + x) * 4;
    red += data[at];
    green += data[at + 1];
    blue += data[at + 2];
    seen++;
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    sample(0, y);
    sample(width - 1, y);
  }
  return [red / seen, green / seen, blue / seen];
}

/**
 * Is what survived one piece, or did the flood eat through it?
 *
 * The test that tells a good cut from a ruined one without anybody looking. A
 * subject that has been hollowed out comes back as a scatter of islands — the
 * night house broke into hundreds — while a correct cut is one blob, plus at
 * most a few genuinely detached specks. So: the largest connected island, as a
 * share of everything kept.
 *
 * It does not care what the subject *is*, which is the point. A gallows is 30%
 * of its own bounding box and perfectly cut; a hollowed house is 29% and
 * ruined. Coverage cannot tell them apart and this can.
 */
function wholeness(background, width, height) {
  const seen = new Uint8Array(width * height);
  let kept = 0;
  let largest = 0;
  for (let index = 0; index < background.length; index++) if (!background[index]) kept++;
  if (kept === 0) return 0;

  for (let start = 0; start < background.length; start++) {
    if (background[start] || seen[start]) continue;
    let size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop();
      size++;
      const x = index % width;
      const y = (index - x) / width;
      const step = (next) => {
        if (!background[next] && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      };
      if (x > 0) step(index - 1);
      if (x < width - 1) step(index + 1);
      if (y > 0) step(index - width);
      if (y < height - 1) step(index + width);
    }
    if (size > largest) largest = size;
  }
  return largest / kept;
}

/** One flood at one tolerance: everything reachable from the border. */
function floodFrom(image, backdrop, tolerance) {
  const { width, height, data } = image;
  const [br, bg, bb] = backdrop;
  const background = new Uint8Array(width * height);
  const stack = [];

  const near = (index) => {
    const at = index * 4;
    return Math.abs(data[at] - br) + Math.abs(data[at + 1] - bg) + Math.abs(data[at + 2] - bb) <= tolerance;
  };
  const push = (index) => {
    if (background[index] || !near(index)) return;
    background[index] = 1;
    stack.push(index);
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (stack.length > 0) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }
  return background;
}

/**
 * The loosest tolerance that still leaves the subject in one piece.
 *
 * Loosest, because every notch tighter leaves more of the backdrop stuck to the
 * sprite as a dark collar; in one piece, because the failure at the loose end is
 * not a collar but a hollowed-out building. Walking down from 60 and stopping at
 * the first tolerance whose result is whole gets both: a bright house settles at
 * the first try, and the night house — the same greys as the ground it stands on
 * — walks down until the flood can no longer get through its walls.
 *
 * The floor is a real answer too. If nothing in the range holds together, the
 * image has no separable backdrop, and the honest thing is to say so rather than
 * ship lace.
 */
function cutBackdrop(image, report) {
  const { width, height, data } = image;
  const backdrop = backdropOf(image);

  let chosen = null;
  let bestScore = 0;
  for (const tolerance of TOLERANCES) {
    const background = floodFrom(image, backdrop, tolerance);
    let removed = 0;
    for (const flag of background) removed += flag;
    // A tolerance that removes nothing has not found the backdrop at all.
    if (removed < width * height * 0.05) continue;
    const whole = wholeness(background, width, height);
    if (whole > bestScore) {
      bestScore = whole;
      chosen = { background, tolerance, whole };
    }
    if (whole >= 0.97) break;
  }
  if (!chosen) throw new Error('no separable backdrop');
  report?.(chosen.tolerance, chosen.whole);

  const { background } = chosen;

  /**
   * And one pixel of the subject with it.
   *
   * The boundary ring has the backdrop mixed into it by the renderer's own
   * antialiasing, so keeping it wraps every sprite in a dark outline. Eroding
   * costs a pixel at 512 and is invisible once the house is drawn 72 wide.
   */
  const eaten = new Uint8Array(background);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (background[index]) continue;
      const touching =
        (x > 0 && background[index - 1]) ||
        (x < width - 1 && background[index + 1]) ||
        (y > 0 && background[index - width]) ||
        (y < height - 1 && background[index + width]);
      if (touching) eaten[index] = 1;
    }
  }

  for (let index = 0; index < width * height; index++) {
    data[index * 4 + 3] = eaten[index] ? 0 : 255;
  }
  return image;
}

/** The smallest box holding every pixel that survived. */
function trim({ width, height, data }) {
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < 0) throw new Error('nothing left after the cut');

  const cut = { width: right - left + 1, height: bottom - top + 1 };
  const out = Buffer.alloc(cut.width * cut.height * 4);
  for (let y = 0; y < cut.height; y++) {
    data.copy(out, y * cut.width * 4, ((top + y) * width + left) * 4, ((top + y) * width + left + cut.width) * 4);
  }
  return { ...cut, data: out };
}

/**
 * Down to size, averaging over the source box each output pixel covers.
 *
 * Averaged in *premultiplied* space, which is the whole trick: mixing a
 * transparent pixel's colour into an opaque neighbour's is how a resize turns
 * a clean cutout back into a fringed one, and it is exactly the artefact this
 * script exists to remove.
 */
function scaleTo({ width, height, data }, longest) {
  const factor = Math.min(1, longest / Math.max(width, height));
  if (factor >= 1) return { width, height, data };
  const out = { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)) };
  const buf = Buffer.alloc(out.width * out.height * 4);

  for (let y = 0; y < out.height; y++) {
    const y0 = Math.floor((y * height) / out.height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / out.height));
    for (let x = 0; x < out.width; x++) {
      const x0 = Math.floor((x * width) / out.width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / out.width));
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let seen = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * width + sx) * 4;
          const a = data[at + 3] / 255;
          red += data[at] * a;
          green += data[at + 1] * a;
          blue += data[at + 2] * a;
          alpha += a;
          seen++;
        }
      }
      const at = (y * out.width + x) * 4;
      if (alpha <= 0) {
        buf[at] = buf[at + 1] = buf[at + 2] = buf[at + 3] = 0;
      } else {
        buf[at] = Math.round(red / alpha);
        buf[at + 1] = Math.round(green / alpha);
        buf[at + 2] = Math.round(blue / alpha);
        buf[at + 3] = Math.round((alpha / seen) * 255);
      }
    }
  }
  return { ...out, data: buf };
}

/* ---------------------------------- run ----------------------------------- */

const [, , from, to, ...rest] = process.argv;
if (!from || !to) {
  console.error('usage: node scripts/art-cutout.mjs <source dir> <destination dir> [--max 256]');
  process.exit(1);
}
const longest = Number(rest[rest.indexOf('--max') + 1]) || 256;

fs.mkdirSync(to, { recursive: true });
const sources = fs
  .readdirSync(from)
  .filter((name) => name.toLowerCase().endsWith('.png'))
  .sort();

for (const source of sources) {
  // ComfyUI appends its queue number; the game wants the name it asked for.
  const name = source.replace(/_\d+_?(?=\.png$)/, '').replace(/\.png$/, '');
  const image = readPng(path.join(from, source));
  const before = image.width * image.height;

  let picked = 0;
  let whole = 1;
  const cut = scaleTo(
    trim(
      cutBackdrop(image, (tolerance, wholeness) => {
        picked = tolerance;
        whole = wholeness;
      })
    ),
    longest
  );

  let solid = 0;
  let partial = 0;
  for (let index = 3; index < cut.data.length; index += 4) {
    if (cut.data[index] === 255) solid++;
    else if (cut.data[index] > 0) partial++;
  }
  const total = cut.width * cut.height;

  writePng(path.join(to, `${name}.png`), cut);
  console.log(
    `${name.padEnd(26)} ${String(cut.width).padStart(4)}x${String(cut.height).padEnd(4)}` +
      ` solid ${((100 * solid) / total).toFixed(1).padStart(5)}%  edge ${((100 * partial) / total).toFixed(1).padStart(5)}%` +
      `  tol ${String(picked).padStart(2)} whole ${(100 * whole).toFixed(0).padStart(3)}%` +
      `  (from ${Math.round(Math.sqrt(before))}²)`
  );
}
