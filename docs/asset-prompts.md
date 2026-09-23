# Prompts de generation des assets

Ce document enregistre mot pour mot les prompts qui ont produit les 64 images de
`D:\ComfyUI\output\final` et les pistes audio de `D:\ComfyUI\output\sa3*`, avec les
reglages exacts du graphe ComfyUI. Il sert a deux choses : regenerer ou corriger un asset
sans repartir de zero, et garder la recette qui a fini par marcher apres une trentaine de
tentatives qui ne marchaient pas.

Les prompts images ne sont pas recopies a la main : ils sont relus dans les metadonnees PNG
des fichiers livres, donc ce qui est ecrit ici est litteralement ce qui a ete envoye au
modele.

## Le poste de generation

ComfyUI dans `D:\ComfyUI`, Radeon RX 6800 (gfx1030) sous ROCm, Windows. Deux scripts de
lancement, parce que les images et l'audio ne veulent pas les memes drapeaux :

| Script                | Usage  | Drapeaux                                                                               |
| --------------------- | ------ | -------------------------------------------------------------------------------------- |
| `run_comfy_rocm.bat`  | images | `--lowvram --fp8_e4m3fn-unet --use-pytorch-cross-attention`                            |
| `run_comfy_audio.bat` | audio  | `--disable-async-offload --disable-dynamic-vram --cpu-vae --fp16-unet --fp32-text-enc` |

Pour l'audio, `--fp16-unet` et `--cpu-vae` ne sont pas des options de confort : en fp32 la
pile de convolutions du vocodeur passe par un solveur MIOpen sans espace de travail et rend
du bruit non deterministe. Et il ne faut jamais passer `--fp8_e4m3fn-text-enc` sur un
encodeur T5, le conditionnement en ressort corrompu et le rendu est quasi silencieux.

---

# Partie 1 : les images (krea2)

## La regle d'ecriture

Chaque prompt est une seule prose continue, assemblee comme `tete + sujet + "." + queue` :

- une **tete plus une queue**, identiques a l'octet pres pour toute une famille, qui
  fixent le genre photographique, le cadrage, la lumiere et le fond ;
- un **sujet** au milieu, le seul morceau qui change d'un asset a l'autre.

Trois choses valent la peine d'etre retenues, parce qu'elles ont chacune coute une serie
ratee :

1. **Le medium doit etre en premier.** Nomme apres cinquante mots de sujet, c'est une
   suggestion ; nomme en tete de phrase, c'est une consigne. C'est ce qui a laisse une
   femme encapuchonnee revenir en plan d'animation japonaise.
2. **Nommer un genre photographique bat decrire une composition.** "Identification
   photograph, passport style" embarque des conventions que le modele connait deja, sujet
   face a l'objectif, centre, fond neutre, lumiere plate, et tient le cadrage bien mieux
   que trois phrases de description d'objectif.
3. **Un sujet ne parle jamais de pose, d'expression, de cadrage, de lumiere ni
   d'accessoires.** Tout cela vit dans la queue, et un sujet qui la contredit gagne.

Le prompt negatif est toujours vide : a cfg 1.0 il n'y a pas de guidance sans classifieur,
donc le conditionnement negatif n'est jamais applique. L'ecrire ne sert a rien.

## Les deux montages

Communs aux deux : UNET `krea2_turbo_fp8_scaled.safetensors` en `fp8_e4m3fn`, encodeur
`Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors` en type `krea2`, VAE
`qwen_image_vae.safetensors`, `EmptySD3LatentImage` 512x512, `ModelSamplingAuraFlow` shift
1.15, KSampler `euler` / `simple`, cfg 1, denoise 1.

|               | Montage A, portraits                                 | Montage B, creatures et pieces Mafia                            |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| Pas           | 4                                                    | 8                                                               |
| Accelerateur  | LoRA `krea2_turbo_4step_rank_64_lora_comfyui` a 0.75 | noeud `Krea2T-Enhancer-Advanced`, strength 1.5, text_scale 1.75 |
| Duree mesuree | environ 98 s par image                               | environ 200 s par image                                         |

krea2 est lie en dur a un Qwen3-VL **4B** : un 8B est refuse au chargement. 512x512 est la
plus petite taille sur laquelle le modele et l'adaptateur ont ete entraines, en dessous les
deux sont hors distribution. Et `krea2filterbypass3` est a eviter : ses douze flottants sur
les couches 8 a 10 sont exactement la variante documentee pour les artefacts de vetement et
le melange d'objets, soit deux des trois defauts qu'on cherchait a corriger.

## Portraits de survivants (CoronaZ)

30 images, `output/final/coronaz/hero/`, destination dans le jeu `apps/front/public/games/coronaz/heroes/`.
Montage A, 4 pas.

**Tete**

```text
Identification photograph, passport style. Front facing head and shoulders portrait of
```

**Queue**

```text
The subject is squared directly to the camera, centred in frame, head upright and level,
looking straight into the lens with a neutral closed-mouth expression. Head and shoulders
only, the top of the head just below the top edge and the crop ending at mid chest. Plain
seamless mid grey backdrop with nothing behind them. Flat even frontal lighting with no
shadow on the backdrop and no rim light. Muted desaturated colour. Their clothing is
scavenged and improvised, layered in mismatched pieces, visibly repaired with tape, wire and
hand stitching, worn through at the edges and ingrained with dirt that will not wash out.
Ordinary unretouched skin with visible pores, broken capillaries, stray hairs, grime and a
faint shine on the forehead. Shot on a digital SLR at eye level, documentary identification
portrait.
```

**Sujets**

`awa` (seed 32246)

> a Black woman in her thirties with close-cropped natural hair, high cheekbones, calm steady
> features, wearing a sun-bleached wrapped headscarf and a patched canvas jacket stiff with
> dust

`bernard` (seed 32145)

> a very large older man in his sixties, cauliflower ears, a heavy grey moustache, a flattened
> nose, wearing a sleeveless shirt gone brown with grime and thick rags wound and taped around
> both forearms

`charles` (seed 31337)

> a lean man in his late fifties, close-cropped grey hair and grey stubble, deep crows feet, a
> weather-beaten filthy face, wearing a torn military surplus jacket over two mismatched
> jumpers, the collar bound with grey duct tape

`chiara` (seed 33761)

> a woman in her late twenties, dark auburn hair falling loose past the shoulders, warm olive
> skin, full brows and even features, wearing a battered suede jacket with the seams
> reinforced in visible cord

`chuck` (seed 31539)

> a stocky man in his forties, round face under a greying beard, ruddy grimy cheeks, wearing a
> padded work coat split at the shoulder seam and repaired with wire, webbing straps crossing
> the chest

`diego` (seed 32751)

> a young man in his twenties, wild dark hair, a few fresh cuts on the forehead and cheek, a
> lean dirty face, wearing a torn sleeveless shirt and a welder-style apron scorched black at
> the edges

`elena` (seed 33357)

> a woman in her mid twenties, dark wavy hair pulled back from an oval face, even features and
> clear olive skin under a film of dust, wearing a cut-down technical jacket patched at the
> shoulder with gaffer tape

`ethan` (seed 33155)

> a young man in his twenties, neat brown hair, wire glasses taped at one hinge, a thoughtful
> narrow face, wearing carefully layered scavenged clothing, each layer worn but deliberately
> arranged

`fatou` (seed 32650)

> a Black woman in her thirties, hair wrapped in a stained patterned headscarf, alert focused
> features, wearing a grimy field jacket with a red cross crudely painted on the shoulder and
> a webbing strap across the chest

`haruto` (seed 33963)

> a man in his mid twenties of japanese descent, black hair swept back, clear skin and sharp
> even features, wearing a slate grey jacket with one sleeve cut away and the arm bound in
> strapping

`ines` (seed 32044)

> a slight woman in her late twenties, straight dark hair tucked behind her ears, pale skin,
> sharp cheekbones, wearing a soot-stained grey hooded jacket with the cuffs bound in black
> tape

`ingrid` (seed 33559)

> a woman in her late twenties, long ash blonde hair tied back, pale skin, strong cheekbones
> and a straight nose, wearing a heavy salvaged wool coat cut short and belted with webbing

`jin` (seed 34165)

> a man in his mid twenties of korean descent, black hair cut short and neat, clear skin and
> calm even features, wearing a technical jacket with the outer layer worn through to the
> lining at the chest

`johanna` (seed 31438)

> a sharp-featured woman in her thirties, dark hair pulled back tight, pale dirt-streaked
> skin, a thin faded scar across one cheekbone, wearing a cut-down leather jacket with one
> sleeve replaced by canvas and strapping across the shoulder

`karim` (seed 32953)

> a lean man in his thirties, close-trimmed black beard, sharp appraising features, wearing a
> cracked leather collar turned up over a scavenged vest strung with cord and salvaged buckles

`lea` (seed 32448)

> a woman in her early forties, short sandy hair pushed back, freckles across her nose and
> cheeks, wearing a denim jacket covered in overlapping hand-stitched patches of different
> fabrics

`luka` (seed 33862)

> a man in his mid twenties, dark tousled hair, a lean symmetrical face with a defined jaw and
> light stubble, wearing a scorched field shirt open over a filthy undershirt, one shoulder
> wrapped in tape

`marco` (seed 31943)

> a broad heavy man in his forties, thick neck, close-cropped black hair, heavy brow, wearing
> a filthy quilted jacket with wide salvaged webbing straps and a length of climbing cord over
> the shoulder

`margot` (seed 33054)

> a weathered woman in her fifties, curly greying hair escaping in all directions, laugh
> lines, wearing a faded quilted jacket mended in a dozen places with mismatched thread and
> odd buttons

`mateo` (seed 34064)

> a man in his late twenties, short dark brown hair, warm olive skin, straight nose and an
> even open face with light stubble, wearing a sun-faded shirt under a vest of salvaged
> webbing and pouches

`mei` (seed 33458)

> a woman in her mid twenties of east asian descent, straight black hair cut to the jaw, fine
> even features, dark eyes, wearing a black quilted jacket with the collar reinforced by
> hand-stitched leather strips

`nadia` (seed 31842)

> a wiry woman in her late twenties, very short practical dark haircut, sharp features, damp
> hair at the temples, wearing a threadbare running jacket patched at both elbows with
> mismatched fabric

`niko` (seed 34266)

> a man in his late twenties, dark curly hair cropped close, warm mediterranean skin, a broad
> even face with a short beard, wearing a heavy canvas jacket stiff with grime and mended
> across the back

`omar` (seed 32549)

> a solid man in his forties, short dark beard, broad calm face, wearing improvised body
> armour of overlapping cut plastic plates lashed over a filthy padded jacket

`rosa` (seed 33256)

> a woman in her fifties, greying hair pulled into a tight bun, an old burn scar up one side
> of the neck, hard set features, wearing a stripped-down uniform jacket with the insignia
> torn off and the holes still showing

`sacha` (seed 31741)

> a tired person in their thirties with short cropped brown hair, dark circles under the eyes,
> an androgynous grimy face, wearing a bloodstained hooded sweatshirt under a cut-down
> high-visibility jacket gone grey with dirt

`suzanne` (seed 32852)

> a woman in her sixties, neat grey hair, wire-rimmed glasses mended at the bridge with tape,
> composed lined features, wearing a ruined tweed jacket with the elbows patched in leather

`viktor` (seed 32347)

> a very tall gaunt pale man in his fifties, hollow cheeks, flat dark hair, wearing a long
> ruined black coat with the lining hanging out, fastened with mismatched buckles and cord

`yuna` (seed 33660)

> a woman in her mid twenties of korean descent, black hair in a low ponytail, smooth clear
> skin and soft even features, wearing a faded work shirt under a jacket rebuilt from two
> different garments

`yuri` (seed 31640)

> a heavy-set man in his forties, shaved head, a badly reset broken nose and a scar along his
> jaw, wearing a scavenged flak vest with the plates showing through torn fabric over a filthy
> thermal layer

## Creatures, biome moderne (CoronaZ)

9 images, `output/final/coronaz/enemy-modern/`, destination dans le jeu `apps/front/public/games/coronaz/enemies/`.
Montage B, 8 pas.

**Tete**

```text
Horror film still, photorealistic. Full length studio shot of
```

**Queue**

```text
It stands upright facing the camera, centred in frame, photographed head to foot with a
little space above and below. The background is pure flat black, completely empty, with no
room, no floor and no objects behind it � the creature is isolated against black. Cleanly
and evenly lit from the front, the whole of it clearly visible, the light falling off gently
toward the edges of the frame the way a real softbox does rather than lighting everything
equally. No lamp or light fixture is visible in frame. Its eyes glow bright sickly yellow
from within. The body is mottled grey-green diseased flesh, slick and wet, with raw red
showing only where the skin has split; dark infected veins spread beneath the surface. A
real photograph of a real physical thing, taken on 35mm film: visible grain, shallow depth
of field so the nearest surfaces are tack sharp and the far edges soften, a faint lens
vignette, and the slightly uneven specular highlights of wet skin under a real light. A
living infected thing, not a skeleton and not a person.
```

**Sujets**

`abomination` (seed 23208)

> a towering, asymmetric, chaotic infected creature of several bodies fused into one, seven
> limbs of wildly different lengths, great lobed tumours bridging the gaps where separate
> torsos merged, wet seams splitting open across the mass, knots of yellow glowing eyes
> clustered irregularly across it, vastly too large

`boss` (seed 22807)

> a colossal, armoured, immovable infected creature, its whole front grown over with
> overlapping plates of hardened tumour like scale armour, seams of raw red glowing between
> them, heavy fused limbs, a blunt featureless head set deep in a collar of growths, yellow
> eyes burning from within the plating

`brute` (seed 22406)

> a hulking, overgrown, top-heavy infected creature, shoulders and arms grown into vast fused
> masses of dense tumour that dwarf the rest of it, knuckles near the ground, a small head
> sunk low between the growths, thick seams split across the back and weeping, two yellow eyes
> almost lost in the bulk

`fatty` (seed 21203)

> an enormous, sagging, tumorous infected creature twice as wide as it is tall, its bulk made
> of fused overgrown masses piled on masses, great pale lobed tumours hanging in sacs from the
> belly and chest and swaying with their own weight, deep seams between them split and weeping
> red, no neck at all and the tiny head half swallowed by the growths, clusters of yellow
> glowing eyes scattered across the tumour surface

`horror` (seed 20802)

> a twisted, asymmetric, lurching infected creature, one whole side overgrown into a heavy
> knotted mass of tumours that drags the shoulder down and forces it to lean, the other side
> wasted thin, a long neck bent sideways under the weight, the face pulled out of shape around
> a single enormous yellow eye

`mutant` (seed 21604)

> a heavy, knotted, aggressive infected creature, thick slabs of overgrown muscle fused under
> the skin into armour-like ridges across the chest and forearms, hardened tumour plates
> capping the shoulders, hands overgrown into blunt splayed claws, a low heavy head with two
> small yellow eyes set deep

`runner` (seed 20401)

> a slimy, lanky, short infected creature, wiry and compact with disproportionately long thin
> limbs folded ready to spring, its whole body sheathed in a dripping mucus film, small hard
> tumours studding the spine and forearms like gravel under the skin, the head narrow and
> eyeless but for two hot yellow points, jaw hanging slack and far too wide

`screamer` (seed 22005)

> a gaunt, distended, shrieking infected creature, its throat swollen into an enormous
> translucent sac ribbed with dark veins and stretched taut, the jaw hinged unnaturally wide
> beneath it, the ribs flared outward around the swelling, thin trailing limbs, yellow eyes
> rolled far back

`walker` (seed 20000)

> a shambling, bloated, slack infected creature, its head swollen lopsided by a cluster of
> pale lobed tumours grown over one side of the skull and sealed shut where the features were,
> more growths budding along the shoulders and back, arms hanging loose and too long, skin
> stretched shiny over the masses beneath, two yellow lights glowing deep in the tumour folds

## Creatures, biome cyber (CoronaZ)

9 images, `output/final/coronaz/enemy-cyber/`, destination dans le jeu `apps/front/public/games/coronaz/enemies/`.
Montage B, 8 pas.

**Tete**

```text
Horror film still, photorealistic. Full length studio shot of
```

**Queue**

```text
It stands upright facing the camera, centred in frame, photographed head to foot with a
little space above and below. The background is pure flat black, completely empty, with no
room, no floor and no objects behind it � the creature is isolated against black. Cleanly
and evenly lit from the front, the whole of it clearly visible, the light falling off gently
toward the edges of the frame the way a real softbox does rather than lighting everything
equally. No lamp or light fixture is visible in frame. Its eyes glow bright sickly yellow
from within. The body is mottled grey-green diseased flesh, slick and wet, with raw red
showing only where the skin has split; dark infected veins spread beneath the surface. A
real photograph of a real physical thing, taken on 35mm film: visible grain, shallow depth
of field so the nearest surfaces are tack sharp and the far edges soften, a faint lens
vignette, and the slightly uneven specular highlights of wet skin under a real light. A
living infected thing, not a skeleton and not a person.
```

**Sujets**

`bloater` (seed 31203)

> a swollen, leaking, ponderous infected machine-creature, corroded tanks on its back fused
> into the flesh and bulging with pale tumour sacs that press through the seams, vents crusted
> and dripping, the whole mass straining against its own plating, yellow eyes small and
> deep-set

`broadcaster` (seed 32005)

> a spined, transmitting, rigid infected machine-creature, antenna spines erupting along the
> spine each sheathed in growth, a dish grafted over the front of the head and warped by the
> tumours pushing behind it, static arcing between the spines, yellow light leaking from every
> seam

`chaser` (seed 30401)

> a slick, skeletal-framed, fast infected machine-creature, long piston-jointed legs wrapped
> in glistening tumour growth, a narrow visored head half consumed by a lobed mass spreading
> over it, torn cables trailing wet behind, two yellow points glowing through the cracked
> visor

`chimera` (seed 31604)

> a bladed, four-armed, predatory infected machine-creature, implanted blades along the
> forearms half grown over with tumour, an armour plate bolted to the skull and lifting away
> as growth pushes it off, a hot yellow glow at the sternum and in both eyes

`enforcer` (seed 32406)

> a heavy, plated, implacable infected machine-creature, riot armour split open across the
> torso by the tumour mass forcing its way out, hydraulic arms seized and overgrown at the
> joints, a sensor bar across the head burning yellow instead of red

`husk` (seed 30000)

> a hollow, corroded, shuffling infected machine-creature, pale tumours bulging out through
> gaps in a rusted chassis and swallowing the plating from inside, cabling fused into the
> growths at the neck, peeling synthetic skin hanging off the masses, one dead optic lens and
> one yellow glow burning through a split in the casing

`juggernaut` (seed 32807)

> a colossal, industrial, unstoppable infected machine-creature, layered armour slabs prised
> apart by vast lobed growths swelling between them, cannon-scale limbs fused solid with
> tumour, a reactor glow gone sickly yellow escaping through the gaps

`singularity` (seed 33208)

> a warped, impossible, radiant infected machine-creature, a collapsing dark core suspended in
> a cage of chrome ribs that tumours have grown through and bound together, the air around it
> visibly bending, yellow light bleeding from the fissures in the mass

`splicer` (seed 30802)

> a mismatched, grafted, twitching infected machine-creature, limbs of different makes badly
> fused together with knots of tumour filling every join, chrome vertebrae half swallowed by
> overgrowth, surgical seams split and weeping, a lopsided head with yellow eyes at different
> heights

## Maisons et decors (Mafia)

10 images, `output/final/mafia/house/`, destination dans le jeu `apps/front/public/games/mafia/`.
Montage B, 8 pas.

**Tete**

```text
Isometric game asset render of
```

**Queue**

```text
A single object centred in frame on a plain flat dark grey background with nothing else in
view, seen in three-quarter isometric view from above at a fixed forty-five degree angle.
Stylised low-poly 3D render with clean matte colours and no surface texture detail, soft
ambient occlusion in the crevices, one soft key light from the upper left and a gentle fill
from the right, crisp readable silhouette, mobile board game art.
```

**Sujets**

`house-cite-boarded` (seed 42005)

> a derelict concrete apartment block with a welded metal shutter over the entrance, planks
> nailed across the lower windows and graffiti across the ground floor

`house-cite-day` (seed 41203)

> a small modern concrete apartment block of four storeys with a flat roof, shallow balconies
> along one face and a single entrance door at ground level

`house-cite-night` (seed 41604)

> a small modern concrete apartment block of four storeys with a flat roof and shallow
> balconies, one window lit and every other window dark

`house-village-boarded` (seed 40802)

> an abandoned village cottage with rough sawn planks nailed in a crossed X over the door and
> one plank across the window, cracked plaster and weeds at the base

`house-village-day` (seed 40000)

> a small village cottage with a steeply pitched tiled roof, timber-framed walls with pale
> plaster between the beams, one closed wooden door and one shuttered window

`house-village-night` (seed 40401)

> a small village cottage with a steeply pitched tiled roof and timber-framed walls, with one
> window glowing warm yellow from inside and the rest of it dark

`prop-fountain` (seed 42406)

> a small stone village fountain with a round carved basin holding still water and a simple
> pillar at its centre

`prop-gallows` (seed 42807)

> a simple wooden gallows standing empty on a square timber platform, a single rope noose
> hanging from the crossbeam and three steps up one side

`prop-tombstone` (seed 43208)

> a weathered stone grave marker at the head of a low mound of turned earth, simple and
> rounded with no legible writing and dead grass at its base

`prop-well` (seed 43609)

> an old stone village well with a low circular wall, a timber frame over it and a bucket
> hanging from a rope on a crank handle

## Modeles de personnage (Mafia)

6 images, `output/final/mafia/model/`, destination dans le jeu `apps/front/public/games/mafia/skins/`.
Montage B, 8 pas.

**Tete**

```text
Isometric game character render of
```

**Queue**

```text
A single character centred in frame on a plain flat dark grey background with nothing else
in view, standing upright and still, squared to the viewer, seen in three-quarter isometric
view from above at a fixed forty-five degree angle, full body from head to foot. Stylised
low-poly 3D character render with clean matte colours and no surface texture detail, simple
rounded forms, soft even studio light from the front and above, crisp readable silhouette,
mobile board game art.
```

**Sujets**

`model-villager-accused` (seed 47802)

> a simple rounded villager townsperson with wrists bound together in front by coarse rope, in
> muted linen and brown with the rope in pale hemp

`model-villager-base` (seed 47000)

> a simple rounded villager townsperson in a plain belted tunic and trousers, the face
> carrying no detail beyond a suggestion of features, in neutral undyed linen and soft brown

`model-villager-dead` (seed 47401)

> a simple rounded villager townsperson rendered pale and semi-transparent like a ghost, in
> washed grey-white and cold blue

`model-villager-doctor` (seed 48604)

> a simple rounded villager townsperson in a white coat holding a small dark medical bag, in
> clean white and pale grey with a single red cross on the bag

`model-villager-mafia` (seed 48203)

> a simple rounded villager townsperson in a dark pinstripe suit and a fedora with the brim
> tipped down to shadow the face, in charcoal and black with a thin red tie

`model-villager-sheriff` (seed 49005)

> a simple rounded villager townsperson in a wide-brimmed hat with a five-pointed star badge
> on the chest, in dusty tan and worn leather brown with silver at the badge

---

# Partie 2 : l'audio (Stable Audio 3)

## Ce qui a ete essaye avant

ACE-Step v1 ne rend que du bruit sur cette carte, y compris avec le gabarit officiel recopie
tel quel. ACE-Step 1.5 turbo rend bien de la musique mais temporellement fausse, et ce n'est
pas un probleme de precision (fp16 et fp32 donnent une correlation de 1.000). MiniMax Music
3 fonctionne mais demande environ 40 minutes par piste et a fait tomber le pilote graphique.
Stable Audio 3 est le seul a rendre du son correct en quelques minutes.

## Le montage

`CheckpointLoaderSimple` sur un des quatre checkpoints, `CLIPLoader` sur
`t5gemma_b_b_ul2.safetensors` en type `stable_audio`, `EmptyLatentAudio`, `KSampler`,
`VAEDecodeAudio`, `SaveAudio` en FLAC.

| Checkpoint                   | Taille | Echantillonnage                               |
| ---------------------------- | ------ | --------------------------------------------- |
| `stable_audio_3_small_music` | 2 Go   | 8 pas, `lcm` / `simple`, cfg 1                |
| `stable_audio_3_small_sfx`   | 2 Go   | 8 pas, `lcm` / `simple`, cfg 1                |
| `stable_audio_3_medium`      | 8,6 Go | 8 pas, `lcm` / `simple`, cfg 1                |
| `stable_audio_3_medium_base` | 8,6 Go | 50 pas, `dpmpp_3m_sde` / `exponential`, cfg 5 |

Les trois premiers sont des distillations LCM : cfg 1 obligatoire, donc prompt negatif inerte
comme pour les images. `medium_base` est le modele avant distillation, c'est le seul ou la
guidance et le prompt negatif servent vraiment. Le negatif utilise :

```text
low quality, noise, hiss, distortion, clipping, muffled, silence, glitch
```

## La regle d'ecriture

Stability entraine ce modele avec une remorque explicite a la fin du prompt, et c'est le
levier de qualite le moins cher qui existe ici :

- musique : une seule phrase fluide, genre, instrument principal, couches de soutien,
  rythme, ambiance, puis `BPM: X. Length: Y seconds` ;
- bruitage : une ou deux phrases denses, source, matiere, espace, forme temporelle, puis
  `Length: X seconds`.

La duree annoncee dans la remorque doit etre egale a `seconds` dans `EmptyLatentAudio`.

## Musique

Six lits de 90 secondes, seed `7000 + index * 131`.

`coronaz-tension`

> Dark ambient horror score with low sustained synth drones, sparse detuned piano notes,
> distant industrial metal clangs, and no drums creating slow unsettling dread. BPM: 60.
> Length: 90 seconds

`coronaz-combat`

> Aggressive industrial action track with pounding distorted drums, a driving low bass
> ostinato, metallic hits and scrapes, and harsh synth stabs creating relentless panicked
> energy. BPM: 140. Length: 90 seconds

`coronaz-safe`

> Quiet fragile ambient piece with warm analog pads, soft felted piano, subtle tape hiss, and
> no percussion creating sparse hopeful calm. BPM: 70. Length: 90 seconds

`mafia-day`

> Smoky noir jazz with muted trumpet lead, piano chords, walking upright bass, and brushed
> drums swinging gently for a relaxed lounge feel. BPM: 95. Length: 90 seconds

`mafia-night`

> Dark noir jazz with sparse double bass, distant clarinet, soft piano, and minimal brushed
> percussion creating tense secretive atmosphere. BPM: 75. Length: 90 seconds

`mafia-trial`

> Tense orchestral cue with low pizzicato strings, ticking clock percussion, sustained cello,
> and rising violin lines creating building courtroom dread. BPM: 100. Length: 90 seconds

## Bruitage

Dix coups, seed `5000 + index * 131`.

`ui-tap`

> Single dry fingertip tap on a wooden table, sharp short transient, close-mic, no reverb.
> Length: 1 second

`ui-confirm`

> Bright two-note confirmation chime rising in pitch, clean digital UI feedback, dry. Length:
> 2 seconds

`ui-deny`

> Short low digital error buzzer, muted and flat, UI feedback, dry. Length: 1 second

`pickup`

> Small metal object picked up, bright short metallic ping with quick decay, close
> perspective, dry. Length: 2 seconds

`hit-flesh`

> Blunt heavy impact on flesh, wet dull thud with deep low-end, close-mic, no reverb. Length:
> 2 seconds

`gunshot`

> Single pistol gunshot in a large empty warehouse, sharp crack with loud echo decay. Length:
> 2 seconds

`zombie-groan`

> Low guttural creature groan with wet rasping breath, close perspective, dark and eerie.
> Length: 4 seconds

`door-creak`

> Wooden door creaking open slowly in an old house, echoing interior, eerie tone. Length: 3
> seconds

`night-bell`

> Distant church bell single toll at night, long natural decay, open-air perspective. Length:
> 6 seconds

`stinger-death`

> Sudden horror stinger, sharp dissonant low strings and a struck piano chord, cinematic,
> short decay. Length: 3 seconds

## Premiere version, gardee pour comparaison

Meme graphe, prompts courts et sans remorque. C'est la version qui a donne le dossier `sa3/`
du comparatif, jugee correcte mais perfectible, et c'est ce qui a motive la reecriture
ci-dessus.

| Nom               | Prompt v1                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coronaz-tension` | Dark ambient horror score, a low sustained drone, sparse detuned piano notes far apart, distant industrial clangs, no drums, slow and unsettling, sixty beats per minute, D minor. |
| `mafia-day`       | Smoky noir jazz, brushed drums, a walking upright bass, muted trumpet, relaxed lounge, ninety five beats per minute, F major.                                                      |
| `ui-tap`          | A single short dry click, like a fingertip tapping a wooden table, close microphone, no reverb.                                                                                    |
| `ui-confirm`      | A single short bright two-note chime rising in pitch, clean and dry, no reverb.                                                                                                    |
| `ui-deny`         | A single short low muted buzz, an error tone, dry and flat, no reverb.                                                                                                             |
| `pickup`          | A single short bright metallic ping as a small object is picked up, dry, no music.                                                                                                 |
| `hit-flesh`       | A single dull heavy wet thud, a blunt impact on flesh, close microphone, no reverb.                                                                                                |
| `gunshot`         | A single dry pistol gunshot with a short sharp crack and brief tail, close microphone, no reverb.                                                                                  |
| `zombie-groan`    | A single low guttural groan with wet rasping breath, a rotting creature close to the microphone, no music.                                                                         |
| `door-creak`      | A single slow creak of an old wooden door opening, dry, close microphone, no reverb.                                                                                               |
| `night-bell`      | A single distant church bell toll, one strike with a long natural decay, night air, no music.                                                                                      |
| `stinger-death`   | A short dramatic orchestral stinger: low strings and a struck piano chord, sudden and final.                                                                                       |

---

# Relancer une generation

Les scripts de soumission parlent a l'API HTTP de ComfyUI (`POST /prompt` avec un graphe au
format API). Ils sont volontairement betes : une liste de sujets, une fonction qui fabrique
le graphe, une boucle de `fetch`.

| Script                               | Ce qu'il envoie                                       |
| ------------------------------------ | ----------------------------------------------------- |
| `portraits.mjs`                      | les 30 portraits, montage A                           |
| `bestiary.mjs`                       | les 18 creatures, montage B                           |
| `submit4.mjs`                        | les familles de `prompts4.mjs`, dont les pieces Mafia |
| `sa3v2.mjs music\|sfx small\|medium` | l'audio, prompts au format Stability                  |
| `sa3base.mjs music\|sfx`             | l'audio sur le modele non distille                    |

Pour ne regenerer qu'un asset, garder son seed et son sujet tels qu'ils sont ecrits ici et ne
changer que ce qui doit changer. Changer le seed change la personne ou la creature, pas
seulement son rendu.
