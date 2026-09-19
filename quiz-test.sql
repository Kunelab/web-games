-- 8 auto-built blindtest rounds + one public playlist.
-- Owner is resolved by login, so this works whatever the user id is.
-- Idempotent: re-running replaces the playlist and its rounds.
BEGIN TRANSACTION;

-- Change this login if you want a different owner.
CREATE TEMP TABLE _owner AS SELECT id FROM Users WHERE login = 'claude' LIMIT 1;
INSERT INTO _owner SELECT id FROM Users WHERE (SELECT COUNT(*) FROM _owner) = 0 ORDER BY id LIMIT 1;

-- Clean any previous run of this script.
DELETE FROM PlaylistItems WHERE playlist_id IN (SELECT id FROM Playlists WHERE name = 'Blind test rap US (test auto)');
DELETE FROM Playlists WHERE name = 'Blind test rap US (test auto)';
DELETE FROM Media WHERE category = 'rap-us' AND kind = 'blindtest';

INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', 'Eminem - Lose Yourself', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"Lose Yourself","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"Eminem","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"Wj7lL6eDOqc","startGuess":113,"endGuess":133,"startReveal":95,"endReveal":115,"volume":100}', NULL);
INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', '50 Cent - In Da Club', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"In Da Club","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"50 Cent","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"_VXUiAJi5KY","startGuess":26,"endGuess":46,"startReveal":9,"endReveal":29,"volume":100}', NULL);
INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', 'Kendrick Lamar - HUMBLE.', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"HUMBLE.","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"Kendrick Lamar","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"ov4WobPqoSA","startGuess":71,"endGuess":91,"startReveal":59,"endReveal":79,"volume":100}', NULL);
INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', 'Kanye West - Stronger', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"Stronger","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"Kanye West","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"PsO6ZnUZI0g","startGuess":80,"endGuess":100,"startReveal":74,"endReveal":94,"volume":100}', NULL);
INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', '2Pac - California Love', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"California Love","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"2Pac","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"omfz62qu_Bc","startGuess":80,"endGuess":100,"startReveal":74,"endReveal":94,"volume":100}', NULL);
INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', 'Snoop Dogg - Gin and Juice', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"Gin and Juice","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"Snoop Dogg","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"fWCZse1iwE0","startGuess":63,"endGuess":83,"startReveal":57,"endReveal":77,"volume":100}', NULL);
INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', 'Dr. Dre - Still D.R.E.', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"Still D.R.E.","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"Dr. Dre","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"Qeem6ZVr8Ic","startGuess":75,"endGuess":95,"startReveal":58,"endReveal":78,"volume":100}', NULL);
INSERT INTO Media (user_id, kind, title, category, date, answers, payload, timing)
VALUES ((SELECT id FROM _owner), 'blindtest', 'JAY Z - Empire State Of Mind', 'rap-us', NULL,
        '[{"key":"title","label":"Titre","value":"Empire State Of Mind","aliases":[],"points":3,"tolerance":0.17,"directBonus":0},{"key":"artist","label":"Artiste","value":"JAY Z","aliases":[],"points":2,"tolerance":0.17,"directBonus":0}]',
        '{"code":"_ydMlTassYc","startGuess":80,"endGuess":100,"startReveal":74,"endReveal":94,"volume":100}', NULL);

INSERT INTO Playlists (user_id, name, type, public, createdAt, updatedAt)
VALUES ((SELECT id FROM _owner), 'Blind test rap US (test auto)', 'blindtest', 1,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Link every round just created, in insertion order.
INSERT INTO PlaylistItems (playlist_id, media_id, order_num)
SELECT (SELECT id FROM Playlists WHERE name = 'Blind test rap US (test auto)'),
       id,
       ROW_NUMBER() OVER (ORDER BY id) - 1
FROM Media WHERE category = 'rap-us' AND kind = 'blindtest';

DROP TABLE _owner;
COMMIT;
