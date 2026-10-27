import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cleanWorkName } from './blindtest-work-names.js';

describe('cleanWorkName', () => {
  it('drops a note about the work, keeping the old name as a spelling', () => {
    assert.deepEqual(cleanWorkName('Drive (film, 2011)', []), { value: 'Drive', aliases: ['Drive (film, 2011)'] });
    assert.deepEqual(cleanWorkName('Les Muppets (série télévisée, 1976)', []).value, 'Les Muppets');
    assert.deepEqual(cleanWorkName('Ghostbusters (2016)', []).value, 'Ghostbusters');
    assert.deepEqual(cleanWorkName('Mushoku Tensei (Season 2)', []).aliases, ['Mushoku Tensei (Season 2)']);
  });

  it('keeps a translation as another name for it', () => {
    assert.deepEqual(cleanWorkName('Les Soprano (The Sopranos)', []), {
      value: 'Les Soprano',
      aliases: ['Les Soprano (The Sopranos)', 'The Sopranos']
    });
  });

  it('keeps the aliases it had, once each', () => {
    assert.deepEqual(cleanWorkName('Boku no Hero Academia (My Hero Academia)', ['My Hero Academia']), {
      value: 'Boku no Hero Academia',
      aliases: ['My Hero Academia', 'Boku no Hero Academia (My Hero Academia)']
    });
  });

  it('leaves a name without a trailing bracket alone', () => {
    assert.deepEqual(cleanWorkName('Titanic', ['Titanic 1997']), { value: 'Titanic', aliases: ['Titanic 1997'] });
    assert.deepEqual(cleanWorkName('(500) jours ensemble', []).value, '(500) jours ensemble');
  });
});
