/* eslint-disable no-console -- a CLI's output is its interface */
import { writeFileSync } from 'node:fs';

import { and, eq, isNull } from 'drizzle-orm';
import { videoInDoubt } from 'game-core';

import { closeDb, db } from '../db/index.js';
import { media } from '../db/schema.js';
import { env } from '../env.js';
import { genreById, NOT_A_SINGLE_WORK, SECTIONS, type Genre } from '../services/blindtest-catalog.js';
import { annotateCandidates, sameWorks } from '../services/blindtest-llm.js';
import { sameWork, titleNames, withoutNames } from '../services/blindtest-video-replace.js';
import { fetchVideoFacts, type VideoFacts } from '../services/youtube-service.js';

/**
 * Flags the catalogue's work rounds whose video is not the work's own music.
 *
 * Films, series, games and anime were filed with covers (piano versions,
 * orchestral remakes, music boxes) and with songs that only share the work's
 * name: "Sixième Sens" played Reol's "THE SIXTH SENSE". Each round's video is
 * read again, its title against the genre's refusals and then by the model,
 * which is told which work the round claims and asked whether the clip is that
 * work's own music. What fails is flagged (`videoDoubt`): it stops being dealt
 * and shows under "Wrong video" in the catalogue editor until an admin puts
 * the right video in, which lifts the flag by itself.
 *
 * Nothing is deleted. A model that did not answer flags nothing.
 *
 *   pnpm --filter back blindtest:video-audit                    # report only
 *   pnpm --filter back blindtest:video-audit --write            # and flag
 *   ... --genre films-musique --limit 200 --report audit.json
 *
 * One YouTube unit per fifty rounds; one model call per twenty-five.
 */

interface Options {
  write: boolean;
  genres: Set<string>;
  limit: number | null;
  report: string | null;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { write: false, genres: new Set(), limit: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--write') options.write = true;
    else if (flag === '--genre') options.genres.add(argv[++index] ?? '');
    else if (flag === '--limit') options.limit = Number(argv[++index]);
    else if (flag === '--report') options.report = argv[++index] ?? null;
    else {
      console.error('usage: blindtest-video-audit [--write] [--genre <id>]... [--limit <n>] [--report <file>]');
      process.exit(2);
    }
  }
  return options;
}

interface Row {
  id: number;
  genre: Genre;
  work: string;
  names: string[];
  code: string;
  payload: Record<string, unknown>;
  facts?: VideoFacts;
  verdict?: { reason: 'cover' | 'not-from-work'; note: string };
  /** The work the model took the video for, when it is not the round's. */
  misread?: string;
  /** Something looked off but not enough to flag: reported only. */
  doubt?: string;
}

function loadRows(options: Options): Row[] {
  const rows: Row[] = [];
  const all = db
    .select({ id: media.id, category: media.category, answers: media.answers, payload: media.payload })
    .from(media)
    .where(and(isNull(media.user_id), eq(media.kind, 'blindtest')))
    .all();
  for (const row of all) {
    const genre = row.category ? genreById.get(row.category) : undefined;
    if (!genre || genre.answerShape !== 'work') continue;
    if (options.genres.size > 0 && !options.genres.has(genre.id)) continue;
    let payload: Record<string, unknown>;
    let answers: { key: string; value: string; aliases?: string[] }[];
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
      answers = JSON.parse(row.answers) as typeof answers;
    } catch {
      continue;
    }
    const code = typeof payload.code === 'string' ? payload.code : '';
    // Already flagged against this very video: nothing new to say.
    if (!code || videoInDoubt(payload)) continue;
    const answer = answers.find((field) => field.key === 'work');
    if (!answer?.value) continue;
    rows.push({
      id: row.id,
      genre,
      work: answer.value,
      names: [answer.value, ...(answer.aliases ?? [])],
      code,
      payload
    });
    if (options.limit !== null && rows.length >= options.limit) break;
  }
  return rows;
}

async function judge(rows: Row[]): Promise<{ asked: number; unanswered: number }> {
  // The title first: what the genre refuses needs no model.
  for (const row of rows) {
    if (!row.facts) continue;
    // The work's own name is not evidence: "A Midi in Time" is a Ratchet & Clank game.
    const title = withoutNames(row.facts.title, row.names);
    if (row.genre.reject?.test(title) || NOT_A_SINGLE_WORK.test(title)) {
      row.verdict = { reason: 'cover', note: `title: ${row.facts.title}` };
    }
  }

  let asked = 0;
  let unanswered = 0;
  const byGenre = new Map<Genre, Row[]>();
  for (const row of rows) {
    if (!row.facts || row.verdict) continue;
    byGenre.set(row.genre, [...(byGenre.get(row.genre) ?? []), row]);
  }
  for (const [genre, group] of byGenre) {
    const label = `${SECTIONS.find((section) => section.id === genre.section)?.label ?? genre.section} / ${genre.label}`;
    const read = await annotateCandidates(
      group.map((row) => ({
        videoId: row.code,
        title: row.facts!.title,
        channel: row.facts!.channel,
        // The round's own work, so the model judges the claim rather than guessing afresh.
        hint: row.work,
        ...(row.facts!.description ? { description: row.facts!.description } : {})
      })),
      'work',
      label
    );
    asked += group.length;
    for (const row of group) {
      const annotation = read.get(row.code);
      if (!annotation) {
        unanswered += 1;
        continue;
      }
      const seen = `${row.facts!.title} [${row.facts!.channel}]`;
      if (annotation.kind === 'reject') {
        // Refused for any reason (a clip, a song from the soundtrack, the genre): too
        // loose to take a round out of play on. Listed for an admin to look at.
        row.doubt = `model refused it: ${seen}`;
      } else if (
        annotation.kind === 'work' &&
        !sameWork([annotation.answer, ...annotation.aliases], row.names) &&
        // A translated answer ("Le Téléphone noir") for a video titled after the round's own work is not a mismatch.
        !titleNames(row.facts!.title, row.names)
      ) {
        row.misread = annotation.answer;
      } else if (annotation.kind === 'work' && annotation.fromWork === false) {
        // Measured on the whole catalogue: false for nine correct videos in ten. Reported only.
        row.doubt = `model doubts it is the work's own music: ${seen}`;
      }
    }
    console.log(`  ${genre.id}: ${group.length} read`);
  }
  // A different name is often the same work in another language ("Le Prince de
  // Bel-Air", "The Fresh Prince of Bel-Air"): asked once more, narrowly, and only
  // a clear "different work" flags.
  const misread = rows.filter((row) => row.misread !== undefined);
  const same = await sameWorks(
    misread.map((row) => ({
      id: String(row.id),
      claimed: row.names.join(' / '),
      read: row.misread!,
      title: row.facts!.title
    }))
  );
  for (const row of misread) {
    const seen = `${row.facts!.title} [${row.facts!.channel}]`;
    const verdict = same.get(String(row.id));
    if (verdict === false)
      row.verdict = { reason: 'not-from-work', note: `model reads it as "${row.misread}": ${seen}` };
    else if (verdict === undefined) row.doubt = `model reads it as "${row.misread}" (unconfirmed): ${seen}`;
  }
  console.log(
    `  ${misread.length} read as another work, ${misread.filter((row) => row.verdict).length} confirmed different`
  );
  return { asked, unanswered };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!env.GOOGLE_API_KEY) {
    console.error('GOOGLE_API_KEY is not set: the videos cannot be read.');
    process.exit(1);
  }
  const rows = loadRows(options);
  console.log(`${rows.length} work rounds to check`);

  const facts = await fetchVideoFacts(rows.map((row) => row.code));
  let gone = 0;
  for (const row of rows) {
    row.facts = facts.get(row.code);
    if (!row.facts) gone += 1;
  }
  console.log(`${gone} whose video YouTube no longer returns (left alone)`);

  const { asked, unanswered } = await judge(rows);
  const flagged = rows.filter((row) => row.verdict);
  console.log(`\n${asked} read by the model, ${unanswered} it did not answer for (left alone)`);
  console.log(`${flagged.length} to flag:`);
  const byReason = new Map<string, number>();
  for (const row of flagged) byReason.set(row.verdict!.reason, (byReason.get(row.verdict!.reason) ?? 0) + 1);
  for (const [reason, count] of byReason) console.log(`  ${reason}: ${count}`);
  for (const row of flagged.slice(0, 60)) {
    console.log(`  #${row.id} ${row.genre.id} "${row.work}" — ${row.verdict!.reason}: ${row.verdict!.note}`);
  }

  const doubtful = rows.filter((row) => row.doubt && !row.verdict);
  console.log(`\n${doubtful.length} only doubtful (not flagged; in the report)`);

  if (options.report) {
    writeFileSync(
      options.report,
      JSON.stringify(
        {
          flagged: flagged.map((row) => ({
            id: row.id,
            genre: row.genre.id,
            work: row.work,
            code: row.code,
            ...row.verdict
          })),
          doubtful: doubtful.map((row) => ({
            id: row.id,
            genre: row.genre.id,
            work: row.work,
            code: row.code,
            note: row.doubt
          }))
        },
        null,
        2
      )
    );
    console.log(`\nreport written to ${options.report}`);
  }

  if (!options.write) {
    console.log('\nDry run: nothing written. Again with --write to flag them.');
    return;
  }
  db.transaction((tx) => {
    for (const row of flagged) {
      const payload = {
        ...row.payload,
        videoDoubt: { reason: row.verdict!.reason, code: row.code, note: row.verdict!.note.slice(0, 300) }
      };
      tx.update(media)
        .set({ payload: JSON.stringify(payload) })
        .where(eq(media.id, row.id))
        .run();
    }
  });
  console.log(`\n${flagged.length} flagged.`);
}

await main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
