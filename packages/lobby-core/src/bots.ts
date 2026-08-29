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
] as const;

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
  const used = new Set(taken);
  const free = BOT_NAMES.filter((name) => !used.has(name));
  // Guarded rather than left to the caller: node's own randomInt throws on 0,
  // and a table that somehow seated 182 bots should still get a name.
  if (free.length === 0) return `Bot ${used.size + 1}`;
  return free[randomInt(free.length)] ?? free[0] ?? `Bot ${used.size + 1}`;
}
