import type { CzClientToServer, CzJoinAck, CzServerToClient, CzView } from 'coronaz-core';
import type { ClientToServerEvents, JoinAck, ServerToClientEvents, SessionView } from 'game-core';
import { msg, type Locale } from 'i18n';
import type { MafiaClientToServer, MafiaJoinAck, MafiaServerToClient, MafiaView } from 'mafia-core';

import { mafiaKeys } from '../tools/mafiaKeys';

import type { SeatKeys, SeatProtocol } from './seat';

function seatKeys(prefix: string): (code: string) => SeatKeys {
  return (code) => ({ token: `${prefix}.${code}`, name: `${prefix}.${code}.name`, id: `${prefix}.${code}.id` });
}

export const quizSeat: SeatProtocol<ClientToServerEvents, ServerToClientEvents, JoinAck, SessionView> = {
  game: 'quiz',
  keys: seatKeys('kune.player'),
  join: 'session:join',
  ask: ({ code, name, token, password }) => ({ code, playerName: name, playerToken: token, password }),
  state: 'session:state',
  error: 'session:error',
  view: (answer) => answer.session,
  refused: msg('play.joinFailed'),
  quiet: msg('play.serverQuiet')
};

export const czSeat: SeatProtocol<CzClientToServer, CzServerToClient, CzJoinAck, CzView> = {
  game: 'coronaz',
  keys: seatKeys('kune.cz.player'),
  join: 'cz:join',
  ask: ({ code, name, token, password }) => ({ code, name, playerToken: token, password }),
  state: 'cz:state',
  error: 'cz:error',
  view: (answer) => answer.view,
  beat: 'cz:beat',
  refused: msg('cz.play.joinFailed'),
  quiet: msg('cz.play.serverQuiet')
};

export const mafiaSeat: SeatProtocol<MafiaClientToServer, MafiaServerToClient, MafiaJoinAck, MafiaView, Locale> = {
  game: 'mafia',
  keys: (code) => ({ token: mafiaKeys.token(code), name: mafiaKeys.name(code) }),
  join: 'mafia:join',
  ask: ({ code, name, token, password }, locale) => ({ code, name, playerToken: token, password, locale }),
  state: 'mafia:state',
  error: 'mafia:error',
  view: (answer) => answer.view,
  beat: 'mafia:beat',
  refused: msg('mafia.ui.joinFailed'),
  quiet: msg('play.serverQuiet')
};
