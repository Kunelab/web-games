import { msg } from 'i18n';
import { quickJoinPath } from 'lobby-core';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { gameEntry } from '../app/games';
import { useT } from '../i18n/locale-context';
import { liveSeats, type Seat } from '../tools/seats';
import { Button } from '../ui';
// The join board's cards, which this reuses wholesale. Imported here rather
// than by each page, so a screen that wants the panel does not also have to
// know which stylesheet it happens to be drawn from.
import '../pages/play.css';

/**
 * The way back into whatever this phone was already in.
 *
 * Every join leaves a token behind, which is what makes a refresh keep your
 * seat, but nothing ever read those tokens to *offer* anything. So a player who
 * closed the tab — or followed a link, or let the phone reboot — had exactly one
 * route back: ask the room to read the code out again, in the middle of a round
 * they were already playing.
 *
 * Nothing at all is drawn when there is nothing to resume, which is most of the
 * time. That is deliberate: this sits above the code box on the way in, and a
 * permanent empty panel there would push the one thing everybody came for
 * further down the page for the sake of a case that is not happening.
 */
export function ResumeSeats() {
  const t = useT();
  const navigate = useNavigate();
  const [seats, setSeats] = useState<Seat[]>([]);

  useEffect(() => {
    let live = true;
    // Checked against the server before anything is offered: a finished game is
    // exactly the entry that would otherwise send somebody to an error screen.
    void liveSeats().then((found) => {
      if (live) setSeats(found);
    });
    return () => {
      live = false;
    };
  }, []);

  if (seats.length === 0) return null;

  return (
    <section className="join-board resume-seats">
      <div className="join-board-head">
        <h2>{t(msg('join.resume.title'))}</h2>
      </div>

      <ul className="join-cards">
        {seats.map((seat) => {
          const entry = gameEntry(seat.game);
          return (
            <li key={`${seat.game}-${seat.code}`} className="join-card" style={{ borderLeftColor: entry.accent }}>
              <span className="join-card-emoji" aria-hidden="true">
                {entry.emoji}
              </span>

              <div className="join-card-body">
                <strong>{entry.name}</strong>
                <span className="join-card-meta">
                  {seat.code} · {t(msg('join.resume.as', { name: seat.name }))}
                </span>
              </div>

              <Button variant="primary" size="sm" onClick={() => void navigate(quickJoinPath(seat.game, seat.code))}>
                {t(msg('join.resume.enter'))}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
