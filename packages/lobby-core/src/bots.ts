/**
 * The cast the machine players draw their names from.
 *
 * Two rules decided what is in here. Fictional, because a bot wearing the name of
 * a living person is a different kind of joke and not one the table agreed to. And
 * spelled **identically in French and English**, because a table mixes both and a
 * bot called `Dark Vador` on one phone and `Darth Vader` on another reads as two
 * players in the same chat log.
 *
 * That second rule is why the list is shorter than it could be: every character
 * whose name is localised had to go, and there are a lot of them — Frodon, Sacha,
 * Bob l'éponge, Dracaufeu, Buzz l'Éclair, Robin des Bois, Rogue, Titi, Dingo. What
 * survived is the set that travels: the capes, most of Star Wars and Nintendo, the
 * monsters, and the shonen leads.
 *
 * It lives in the lobby rather than in a game because every game in the house now
 * seats bots from the same room, and two lists would drift into two casts.
 */
export const BOT_NAMES = [
  // Capes
  "Batman",
  "Superman",
  "Spider-Man",
  "Iron Man",
  "Hulk",
  "Thor",
  "Loki",
  "Wolverine",
  "Magneto",
  "Deadpool",
  "Catwoman",
  "Harley Quinn",
  "Aquaman",
  "Wonder Woman",
  "Captain America",
  "Black Panther",
  "Doctor Strange",
  "Venom",
  "Groot",
  "Thanos",
  "Hellboy",
  "Zorro",

  "Robin",
  "Joker",
  "Bane",
  "Gambit",
  "Ultron",
  "Galactus",
  "Blade",
  "Rocket",
  "Drax",
  "Gamora",
  "Nebula",
  "Carnage",
  "Mystique",
  "Punisher",
  "Nick Fury",
  // Star Wars
  "Yoda",
  "Han Solo",
  "Chewbacca",
  "R2-D2",
  "C-3PO",
  "Boba Fett",
  "Obi-Wan Kenobi",
  "Luke Skywalker",
  "Leia",
  "Palpatine",
  "BB-8",

  "Rey",
  "Finn",
  "Kylo Ren",
  "Ahsoka",
  "Grogu",
  "Mace Windu",
  "Jango Fett",
  "Lando",
  "Jabba",
  // Terre du Milieu
  "Gandalf",
  "Legolas",
  "Aragorn",
  "Gimli",
  "Gollum",
  "Sauron",
  "Saruman",
  "Galadriel",
  "Arwen",
  "Smaug",

  "Thorin",
  "Elrond",
  "Boromir",
  "Balrog",
  "Radagast",
  // Manettes
  "Mario",
  "Luigi",
  "Bowser",
  "Yoshi",
  "Toad",
  "Donkey Kong",
  "Link",
  "Zelda",
  "Ganondorf",
  "Samus",
  "Kirby",
  "Pikachu",
  "Mewtwo",
  "Sonic",
  "Tails",
  "Knuckles",
  "Mega Man",
  "Kratos",
  "Lara Croft",
  "Master Chief",
  "Geralt",
  "Ciri",
  "Aloy",
  "Ezio",
  "Solid Snake",
  "Ryu",
  "Chun-Li",
  "Scorpion",
  "Sub-Zero",
  "Pac-Man",
  "Crash Bandicoot",
  "Spyro",
  "Rayman",
  "Sephiroth",
  "Nathan Drake",
  "Jill Valentine",
  "Gordon Freeman",

  "Wario",
  "Waluigi",
  "Peach",
  "Daisy",
  "Diddy Kong",
  "Bayonetta",
  "Tifa",
  "Aerith",
  "Squall",
  "Leon Kennedy",
  "Ada Wong",
  "Nemesis",
  "Alyx",
  "Arthur Morgan",
  "Big Boss",
  "Raiden",
  "Dante",
  "Joel",
  "Ellie",
  "Jinx",
  "Teemo",
  "Steve",
  "Herobrine",
  "Creeper",
  "Enderman",
  "Eevee",
  "Lucario",
  "Arceus",
  "Rayquaza",
  // Japanimation
  "Son Goku",
  "Vegeta",
  "Piccolo",
  "Naruto",
  "Sasuke",
  "Kakashi",
  "Itachi",
  "Luffy",
  "Zoro",
  "Nami",
  "Sanji",
  "Saitama",
  "Levi",
  "Mikasa",
  "Ryuk",
  "Totoro",
  "Sailor Moon",
  "Alucard",
  "Guts",

  "Gojo",
  "Sukuna",
  "Tanjiro",
  "Nezuko",
  "Zenitsu",
  "Eren",
  "Armin",
  "Edward Elric",
  "Alphonse",
  "Roy Mustang",
  "Ichigo",
  "Rukia",
  "Aizen",
  "Killua",
  "Hisoka",
  "Meliodas",
  "Escanor",
  "Yuno",
  "Denji",
  "Makima",
  "Shinji",
  "Asuka",
  "Spike Spiegel",
  "Jotaro",
  // Grand écran
  "Dracula",
  "Frankenstein",
  "Godzilla",
  "King Kong",
  "Terminator",
  "RoboCop",
  "Rambo",
  "Neo",
  "Morpheus",
  "Trinity",
  "Indiana Jones",
  "James Bond",
  "Jack Sparrow",
  "Hannibal Lecter",
  "Freddy Krueger",
  "Michael Myers",
  "Chucky",
  "Beetlejuice",
  "Gizmo",
  "Optimus Prime",
  "Megatron",
  "John Wick",
  "Marty McFly",
  "Doc Brown",
  "Tarzan",
  "Mowgli",
  "Baloo",
  "Shere Khan",
  "Simba",
  "Mufasa",
  "Scar",
  "Timon",
  "Pumbaa",
  "Aladdin",
  "Mulan",
  "Elsa",
  "Olaf",
  "Shrek",
  "Nemo",
  "Dory",
  "Wall-E",
  "Woody",
  "Mickey Mouse",
  "Minnie",
  "Donald Duck",
  "Bugs Bunny",
  "Daffy Duck",
  "Tom",
  "Jerry",
  "Popeye",
  "Casper",
  "Snoopy",
  "Garfield",
  "Barbie",
  "Tintin",
  "Lucky Luke",
  "Marsupilami",

  "Ripley",
  "Xenomorph",
  "Predator",
  "Forrest Gump",
  "Vito Corleone",
  "Scarface",
  "Jack Torrance",
  "Norman Bates",
  "Leatherface",
  "Jigsaw",
  "Ghostface",
  "Jason Voorhees",
  "Pinhead",
  "Nosferatu",
  "Van Helsing",
  "Morticia",
  "Gomez",
  "Mad Max",
  "Furiosa",
  "Agent Smith",
  "Gru",
  "Sulley",
  "Mike Wazowski",
  "Remy",
  "Merida",
  "Maui",
  "Ursula",
  "Cruella",
  "Jafar",
  "Stitch",
  "Bambi",
  "Dumbo",
  "Pinocchio",
  "Rafiki",
  "Nala",
  "Bagheera",
  // Petit écran
  "Homer Simpson",
  "Bart Simpson",
  "Lisa Simpson",
  "Ned Flanders",
  "Bender",
  "Leela",
  "Eric Cartman",
  "Stewie Griffin",
  "Rick Sanchez",
  "Morty",
  "Walter White",
  "Jesse Pinkman",
  "Tony Soprano",
  "Sherlock Holmes",
  "Moriarty",
  "Hercule Poirot",
  "Jon Snow",
  "Daenerys",
  "Tyrion",
  "Arya Stark",
  "Harry Potter",
  "Hermione",
  "Dumbledore",
  "Voldemort",
  "Hagrid",
  "Dobby",
  "Saul Goodman",
  "Gus Fring",
  "Dexter",
  "Daryl",
  "Negan",
  "Eleven",
  "Demogorgon",
  "Hopper",
  "Ragnar",
  "Yennefer",
  "Cersei",
  "Sansa",
  "Hodor",
  "Joffrey",
  "Khal Drogo",
  "Jorah",
  "Varys",
  "Littlefinger",
  "Spirou",
  "Fantasio",
  "Gaston",

  /**
   * Myth, which is the one cast older than all of the above.
   *
   * Gods and monsters travel better than characters do: most of them are spelled
   * the same in both languages, and the handful that differ differ by an accent
   * or a letter — Hera and Héra, Apollo and Apollon — which is close enough that
   * nobody reads them as two players. Drawn from everywhere rather than from
   * Greece and Scandinavia twice, because a table of twenty-four wants range and
   * because the rest of the world has better names in it than the two pantheons
   * everybody already knows.
   *
   * Two that had to go and are worth writing down: Hathor, because `tooAlike`
   * reads "Thor" inside it, and Inti, because it is inside "Tintin". Both are
   * real collisions with names already above, and the test below the list is
   * what caught them.
   */
  // Olympe
  "Zeus",
  "Hera",
  "Athena",
  "Apollo",
  "Artemis",
  "Poseidon",
  "Hades",
  "Ares",
  "Hermes",
  "Hestia",
  "Persephone",
  "Hecate",
  "Hypnos",
  "Nyx",
  "Cronos",
  "Atlas",
  "Triton",
  "Charon",
  // Nil
  "Anubis",
  "Osiris",
  "Horus",
  "Sekhmet",
  "Sobek",
  "Bastet",
  "Apophis",
  "Nephthys",
  // Nord
  "Odin",
  "Freya",
  "Heimdall",
  "Fenrir",
  "Valkyrie",
  "Ymir",
  "Njord",
  "Baldr",
  "Frigg",
  "Sleipnir",
  // Japon
  "Amaterasu",
  "Susanoo",
  "Tsukuyomi",
  "Izanagi",
  "Raijin",
  "Fujin",
  "Hachiman",
  // Chine
  "Wukong",
  "Nezha",
  "Pangu",
  "Nuwa",
  "Guanyin",
  "Erlang",
  // Afrique
  "Anansi",
  "Shango",
  "Ogun",
  "Oshun",
  "Yemoja",
  "Nyame",
  "Eshu",
  // Inde
  "Ganesha",
  "Hanuman",
  "Garuda",
  "Indra",
  "Kali",
  "Vishnu",
  "Shiva",
  "Durga",
  // Mesopotamie
  "Marduk",
  "Tiamat",
  "Gilgamesh",
  "Enki",
  "Ishtar",
  // Mesoamerique et Andes
  "Quetzalcoatl",
  "Tezcatlipoca",
  "Viracocha",
  "Kukulkan",
  // Celtes et Slaves
  "Morrigan",
  "Cernunnos",
  "Dagda",
  "Lugh",
  "Perun",
  "Baba Yaga",
  // Pacifique
  "Tangaroa",
] as const;

/**
 * One name, stripped to the letters a reader actually compares.
 *
 * Case, accents, spaces and punctuation all go: "R2-D2" and "r2d2" are the same
 * seat to anybody skimming a roster, and so are "Léa" and "Lea".
 */
function plain(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Levenshtein, stopped as soon as it is past caring. */
function distance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    let best = row;
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const step = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
      current.push(step);
      if (step < best) best = step;
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

/**
 * Two names a player would have to stop and compare.
 *
 * A bot called Mario at a table with a Wario, or a Thor sitting next to a
 * Thorin, is not a joke, it is a vote cast at the wrong seat: the chat prints a
 * name beside every line and the roster prints it again, and one letter is not
 * enough to tell two people apart while the clock is running. Reported from a
 * table where somebody typed a name and the room argued about which of two
 * seats they meant.
 *
 * Three ways of being too close, in the order people actually confuse them:
 * the same letters; one name sitting inside the other, which is how nicknames
 * and house numbers go wrong; and a couple of letters' difference, scaled to
 * the length, because two letters out of four is a different name and two out
 * of nine is a typo.
 */
export function tooAlike(left: string, right: string): boolean {
  const a = plain(left);
  const b = plain(right);
  if (!a || !b) return false;
  if (a === b) return true;

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.includes(short)) return true;

  const allowed = short.length >= 5 ? 2 : short.length === 4 ? 1 : 0;
  return allowed > 0 && distance(a, b, allowed) <= allowed;
}

/**
 * A free name, drawn at random rather than taken in order.
 *
 * Walking the list from the top is what both games used to do, and it meant the
 * first bot was always the same character and everything past the fifth was
 * decoration. Drawing is the whole point of having a cast this size.
 *
 * `randomInt` is supplied so the caller owns its randomness — the engines here are
 * tested by handing them a counter instead of a die.
 */
export function pickBotName(
  taken: Iterable<string>,
  randomInt: (maxExclusive: number) => number,
): string {
  const used = [...taken];
  /**
   * Not merely unused: not *confusable* with anybody already sitting down.
   *
   * The name a person chose is the one that stays, so the bots move out of its
   * way — including out of the way of a player who has typed something one
   * letter off a character in the cast, which is exactly when the two get mixed
   * up. See `tooAlike`.
   */
  const free = BOT_NAMES.filter((name) => !used.some((sitting) => tooAlike(name, sitting)));

  /**
   * And if the room has somehow used up a cast this size, or a table of near
   * misses has eaten it, a plain numbered name rather than a collision.
   *
   * Guarded rather than left to the caller for the boring reason as well:
   * node's own randomInt throws on a zero range.
   */
  if (free.length === 0) {
    let index = used.length + 1;
    while (used.some((sitting) => plain(sitting) === plain(`Bot ${index}`))) index++;
    return `Bot ${index}`;
  }
  return free[randomInt(free.length)] ?? free[0] ?? `Bot ${used.length + 1}`;
}
