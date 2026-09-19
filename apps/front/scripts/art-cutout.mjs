/**
 * Turning a rendered sprite into a cutout the game can paint.
 *
 * The art arrives out of ComfyUI as flat RGB on a studio backdrop: no alpha, a
 * uniform grey behind the subject, and a 512×512 frame with the subject
 * somewhere in the middle of it. A town made of those is a town of grey
 * postcards. What the board needs is the subject alone, trimmed to its own
 * edges, so a house can be anchored to a tile and a villager can stand in front
 * of one.
 *
 * So this keys the backdrop out and crops to what is left. Pure Node — no
 * sharp, no ImageMagick, nothing to install on the machine that happens to be
 * doing the export — because the whole point is that new art can be dropped in
 * and turned into game assets in one command.
 *
 *   node apps/front/scripts/art-cutout.mjs <in.png> <out.png> [--max=512]
 *   node apps/front/scripts/art-cutout.mjs <in-dir> <out-dir> [--max=512]
 *
 * Three steps, in order, and each is there for a reason the naive version got
 * wrong:
 *
 *  - **Flood the backdrop from the edges** rather than keying every pixel that
 *    matches it. A house has shadows and dark window frames the same value as
 *    the grey behind it, and a global key punches holes straight through them.
 *    Background is what the border can reach.
 *  - **Feather the edge.** A hard threshold leaves a one-pixel grey halo that
 *    reads as a sticker on every screen. Alpha ramps across the band between
 *    the two thresholds instead.
 *  - **Crop to the ink.** The subject's own bounding box is what gets anchored
 *    to a tile; 512 squares of mostly nothing make every position a guess.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

/* --------------------------------- PNG I/O -------------------------------- */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, the one PNG wants, table built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** One PNG, as straight RGBA rows. Handles what ComfyUI actually writes. */
function readPng(file) {
  const buffer = readFileSync(file);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file}: not a PNG`);

  let at = 8;
  let header = null;
  const idat = [];
  let palette = null;
  let transparency = null;

  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    at += 12 + length;

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        interlace: data[12]
      };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
  }

  if (!header) throw new Error(`${file}: no header`);
  if (header.depth !== 8) throw new Error(`${file}: only 8 bits per channel (got ${header.depth})`);
  if (header.interlace !== 0) throw new Error(`${file}: interlaced PNGs are not supported`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colour];
  if (!channels) throw new Error(`${file}: unsupported colour type ${header.colour}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(header.width * header.height * 4);

  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    unfilter(filter, row, previous, channels);
    previous = row;

    for (let x = 0; x < header.width; x++) {
      const from = x * channels;
      const to = (y * header.width + x) * 4;
      if (header.colour === 3) {
        const index = row[from] * 3;
        pixels[to] = palette[index];
        pixels[to + 1] = palette[index + 1];
        pixels[to + 2] = palette[index + 2];
        pixels[to + 3] = transparency?.[row[from]] ?? 255;
      } else if (header.colour === 0 || header.colour === 4) {
        pixels[to] = pixels[to + 1] = pixels[to + 2] = row[from];
        pixels[to + 3] = header.colour === 4 ? row[from + 1] : 255;
      } else {
        pixels[to] = row[from];
        pixels[to + 1] = row[from + 1];
        pixels[to + 2] = row[from + 2];
        pixels[to + 3] = header.colour === 6 ? row[from + 3] : 255;
      }
    }
  }

  return { width: header.width, height: header.height, pixels };
}

/** The five PNG row filters, undone in place. */
function unfilter(type, row, previous, channels) {
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let index = 0; index < row.length; index++) {
    const left = index >= channels ? row[index - channels] : 0;
    const up = previous[index];
    const upLeft = index >= channels ? previous[index - channels] : 0;
    if (type === 1) row[index] = (row[index] + left) & 0xff;
    else if (type === 2) row[index] = (row[index] + up) & 0xff;
    else if (type === 3) row[index] = (row[index] + ((left + up) >> 1)) & 0xff;
    else if (type === 4) row[index] = (row[index] + paeth(left, up, upLeft)) & 0xff;
  }
}

function writePng(file, { width, height, pixels }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  writeFileSync(
    file,
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ])
  );
}

/* -------------------------------- the cutout ------------------------------ */

/** Everything closer than this to the backdrop colour is certainly backdrop. */
const TIGHT = 26;
/** Everything past this is certainly not. Between the two, alpha ramps. */
const LOOSE = 64;

const distance = (pixels, at, colour) => {
  const dr = pixels[at] - colour[0];
  const dg = pixels[at + 1] - colour[1];
  const db = pixels[at + 2] - colour[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

/**
 * The backdrop colour, taken from the corners.
 *
 * The median of the four rather than the mean, so one corner that happens to
 * hold a bit of the subject does not drag the key off the actual backdrop.
 */
function backdrop({ width, height, pixels }) {
  const corners = [
    [2, 2],
    [width - 3, 2],
    [2, height - 3],
    [width - 3, height - 3]
  ].map(([x, y]) => {
    const at = (y * width + x) * 4;
    return [pixels[at], pixels[at + 1], pixels[at + 2]];
  });
  return [0, 1, 2].map((channel) => {
    const values = corners.map((corner) => corner[channel]).sort((a, b) => a - b);
    return Math.round((values[1] + values[2]) / 2);
  });
}

/**
 * Alpha from the edges inwards.
 *
 * A queue rather than recursion: 512×512 of flat backdrop is a quarter of a
 * million pixels and a recursive fill runs out of stack somewhere around the
 * middle of the first row.
 */
function key(image) {
  const { width, height, pixels } = image;
  const colour = backdrop(image);
  const outside = new Uint8Array(width * height);
  const queue = [];

  const consider = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (outside[index]) return;
    if (distance(pixels, index * 4, colour) >= LOOSE) return;
    outside[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x++) {
    consider(x, 0);
    consider(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    consider(0, y);
    consider(width - 1, y);
  }

  while (queue.length > 0) {
    const index = queue.pop();
    const x = index % width;
    const y = (index - x) / width;
    consider(x - 1, y);
    consider(x + 1, y);
    consider(x, y - 1);
    consider(x, y + 1);
  }

  for (let index = 0; index < width * height; index++) {
    if (!outside[index]) continue;
    const far = distance(pixels, index * 4, colour);
    pixels[index * 4 + 3] = far <= TIGHT ? 0 : Math.round((255 * (far - TIGHT)) / (LOOSE - TIGHT));
  }
  return image;
}

/** The subject's own box, with a hair of margin so the feather is not clipped. */
function crop(image) {
  const { width, height, pixels } = image;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < 8) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (right < 0) return image;

  left = Math.max(0, left - 1);
  top = Math.max(0, top - 1);
  right = Math.min(width - 1, right + 1);
  bottom = Math.min(height - 1, bottom + 1);

  const cut = { width: right - left + 1, height: bottom - top + 1 };
  const out = Buffer.alloc(cut.width * cut.height * 4);
  for (let y = 0; y < cut.height; y++) {
    pixels.copy(out, y * cut.width * 4, ((y + top) * width + left) * 4, ((y + top) * width + left + cut.width) * 4);
  }
  return { ...cut, pixels: out };
}

/** Halve until it fits, averaging 2×2 blocks. Alpha-weighted, or edges go grey. */
function shrink(image, max) {
  let current = image;
  while (Math.max(current.width, current.height) > max) {
    const width = Math.max(1, current.width >> 1);
    const height = Math.max(1, current.height >> 1);
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let weight = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1]
        ]) {
          const sx = Math.min(current.width - 1, x * 2 + dx);
          const sy = Math.min(current.height - 1, y * 2 + dy);
          const at = (sy * current.width + sx) * 4;
          const alpha = current.pixels[at + 3];
          r += current.pixels[at] * alpha;
          g += current.pixels[at + 1] * alpha;
          b += current.pixels[at + 2] * alpha;
          a += alpha;
          weight += 255;
        }
        const to = (y * width + x) * 4;
        out[to] = a > 0 ? Math.round(r / a) : 0;
        out[to + 1] = a > 0 ? Math.round(g / a) : 0;
        out[to + 2] = a > 0 ? Math.round(b / a) : 0;
        out[to + 3] = Math.round((a / weight) * 255);
      }
    }
    current = { width, height, pixels: out };
  }
  return current;
}

/* ---------------------------------- the CLI -------------------------------- */

function convert(from, to, max) {
  const done = shrink(crop(key(readPng(from))), max);
  writePng(to, done);
  const size = statSync(to).size;
  console.log(
    `  ${basename(from).padEnd(36)} → ${basename(to).padEnd(28)} ${done.width}×${done.height}  ${(size / 1024).toFixed(0)} KB`
  );
  return createHash('sha1').update(readFileSync(to)).digest('hex').slice(0, 8);
}

const args = process.argv.slice(2);
const max = Number(args.find((arg) => arg.startsWith('--max='))?.split('=')[1] ?? 512);
const [from, to] = args.filter((arg) => !arg.startsWith('--'));

if (!from || !to) {
  console.error('usage: art-cutout.mjs <in.png|in-dir> <out.png|out-dir> [--max=512]');
  process.exit(1);
}

if (statSync(from).isDirectory()) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).filter((file) => extname(file).toLowerCase() === '.png')) {
    // `house-village-day_00001_.png` is a render counter, not an id: the game
    // addresses art by name, and the name is the part in front of it.
    const id = basename(name, '.png').replace(/_\d+_?$/, '');
    convert(join(from, name), join(to, `${id}.png`), max);
  }
} else {
  convert(from, to, max);
}
