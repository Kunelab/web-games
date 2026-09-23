# Registre des activités de traitement

**Document interne. Ne pas publier.**

L'article 30 du RGPD demande à tout responsable de traitement de tenir un
registre de ce qu'il fait des données personnelles. Il n'est pas public : il est
présenté à la CNIL si elle le demande, et il sert surtout à savoir soi-même ce
que le service conserve.

Ce fichier est la version de ce registre pour KuneLab. Il décrit l'état réel du
code, pas une intention : quand un traitement change, ce fichier change dans le
même commit. La page publique correspondante est
[confidentialite.html](https://kunelab.duckdns.org/confidentialite.html), et les
deux doivent dire la même chose.

Dernière mise à jour : 20 septembre 2026.

## Responsable de traitement

Maxime Pinard, à titre non professionnel, sans activité commerciale.
Contact : kunelabcontact@duck.com.

Pas de délégué à la protection des données : aucune des trois conditions de
l'article 37 n'est remplie (pas d'organisme public, pas de suivi à grande
échelle, pas de données sensibles à grande échelle).

## Traitements

### 1. Comptes utilisateurs

|                        |                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Finalité**           | Permettre de se connecter, de retrouver sa bibliothèque, et de réinitialiser un mot de passe oublié           |
| **Base légale**        | Exécution du contrat, art. 6.1.b                                                                              |
| **Personnes**          | Toute personne qui crée un compte sur games.kunelab.duckdns.org                                               |
| **Données**            | Pseudo, adresse email, empreinte argon2id du mot de passe, rôle, date de création, date de dernière connexion |
| **Où**                 | Table `Users`, SQLite, volume Docker `web-games-data`                                                         |
| **Conservation**       | Jusqu'à suppression du compte, sur demande à l'adresse de contact                                             |
| **Destinataires**      | Personne                                                                                                      |
| **Transferts hors UE** | Aucun                                                                                                         |

Le mot de passe n'est jamais conservé en clair et ne peut pas être retrouvé :
argon2id, 19 Mio, `apps/back/src/services/user-service.ts`.

### 2. Contenus créés

|                   |                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **Finalité**      | Stocker les questions, médias et playlists à partir desquels les parties se jouent          |
| **Base légale**   | Exécution du contrat, art. 6.1.b                                                            |
| **Données**       | Contenus saisis par l'utilisateur, rattachés à son identifiant                              |
| **Où**            | Tables `Media`, `Playlists`, `PlaylistItems`, plus les tables héritées `Videos` et `Images` |
| **Conservation**  | Jusqu'à suppression du compte                                                               |
| **Destinataires** | Les autres utilisateurs, pour les playlists marquées publiques uniquement                   |

### 3. Parties terminées et classements

|                  |                                                                             |
| ---------------- | --------------------------------------------------------------------------- |
| **Finalité**     | Historique des parties, classements, badges                                 |
| **Base légale**  | Exécution du contrat, art. 6.1.b                                            |
| **Données**      | Pseudos de joueurs, scores, statistiques par partie, date                   |
| **Où**           | Tables `GameResults`, `QuizCareers`, `CzCareers`, `MafiaCareers`            |
| **Conservation** | Sans limite : une partie terminée est aussi l'historique des autres joueurs |

Un pseudo de joueur est ce qui est tapé à l'écran d'accueil et n'est rattaché à
aucun compte. À la suppression d'un compte, les parties animées sont conservées
mais la colonne `host_user_id` passe à `NULL` (voir `eraseUser` dans
`apps/back/src/cli/admin.ts`).

### 4. Enregistrements de parties

|                  |                                                                       |
| ---------------- | --------------------------------------------------------------------- |
| **Finalité**     | Pouvoir expliquer après coup une partie qui s'est mal passée          |
| **Base légale**  | Intérêt légitime à corriger le logiciel, art. 6.1.f                   |
| **Données**      | Déroulé complet d'une partie, messages de chat compris                |
| **Où**           | Fichiers `.jsonl` dans `/data/traces`                                 |
| **Conservation** | Les 10 plus récents par jeu, rotation automatique (`GAME_TRACE_KEEP`) |

**Balance des intérêts.** L'intérêt est réel : sans enregistrement, un bug de
moteur survenu une fois n'est pas reproductible et ne sera pas corrigé.
L'atteinte est limitée par la rotation courte, par l'absence de tout accès
extérieur au volume, et par le fait que les chaînes sont tronquées sauf en mode
`full`. Peut être désactivé par `GAME_TRACE=off`.

### 5. Rapports de bug

|                  |                                                                               |
| ---------------- | ----------------------------------------------------------------------------- |
| **Finalité**     | Recevoir et traiter les signalements de problèmes                             |
| **Base légale**  | Intérêt légitime à corriger le logiciel, art. 6.1.f                           |
| **Données**      | Message libre, page d'origine, user-agent, code de partie, pseudo si connecté |
| **Où**           | Table `BugReports`                                                            |
| **Conservation** | Jusqu'au traitement du bug, puis suppression (`DELETE /api/bugs/:id`)         |

### 6. Sessions de connexion

|                  |                                                              |
| ---------------- | ------------------------------------------------------------ |
| **Finalité**     | Garder l'utilisateur connecté d'une page à l'autre           |
| **Base légale**  | Exécution du contrat, art. 6.1.b                             |
| **Données**      | Identifiant de session, identifiant et rôle de l'utilisateur |
| **Où**           | Table `Sessions`, cookie `kune.sid`                          |
| **Conservation** | 7 jours, balayage horaire des expirées                       |

Cookie strictement nécessaire : exempté de consentement, donc pas de bandeau.

### 7. Réinitialisation de mot de passe

|                  |                                                                        |
| ---------------- | ---------------------------------------------------------------------- |
| **Finalité**     | Permettre de reprendre la main sur un compte                           |
| **Base légale**  | Exécution du contrat, art. 6.1.b                                       |
| **Données**      | Empreinte SHA-256 du jeton, identifiant utilisateur, date d'expiration |
| **Où**           | Table `PasswordResets`                                                 |
| **Conservation** | 1 heure, usage unique, purge à chaque émission                         |

Le jeton en clair n'est jamais stocké.

### 8. Journaux serveur

|                  |                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------- |
| **Finalité**     | Sécurité, détection d'abus, diagnostic de panne                                       |
| **Base légale**  | Intérêt légitime, art. 6.1.f                                                          |
| **Données**      | Adresses IP, requêtes, horodatages                                                    |
| **Où**           | Journaux Apache et journaux applicatifs sur la machine                                |
| **Conservation** | À fixer explicitement. La CNIL recommande 6 mois au plus pour des journaux de ce type |

> **À faire.** La rotation des journaux Apache n'a pas été vérifiée lors de la
> rédaction de ce registre. Vérifier `/etc/logrotate.d/apache2` sur le mini PC et
> fixer la durée à 6 mois maximum.

## Sous-traitants et destinataires

| Qui              | Quoi                                                              | Où         | Base du transfert                                                                                                          |
| ---------------- | ----------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| Google (YouTube) | Adresse IP du visiteur, identifiant de l'extrait lu               | États-Unis | Clauses contractuelles types, DPF. Lecteur chargé depuis `youtube-nocookie.com` : pas de cookie publicitaire               |
| Groq, Anthropic  | Messages de chat et pseudos d'une table Mafia comportant des bots | États-Unis | Clauses contractuelles types. **Évitable** : `MAFIA_BOT_PROVIDER=ollama` fait tourner le modèle localement et rien ne sort |
| Wikimedia        | Rien du visiteur                                                  | —          | Les images sont récupérées par le serveur et relayées ; Wikimedia voit l'adresse du serveur, jamais celle du visiteur      |

Aucun autre destinataire. Aucune mesure d'audience, aucune régie publicitaire,
aucune revente, aucun partage à des fins marketing.

## Mesures de sécurité

- Mots de passe en argon2id (19 Mio, t=2, p=1), relevés automatiquement à la
  connexion si les paramètres stockés sont plus faibles que la politique
- Limitation de débit sur la connexion (10/min/IP), l'inscription (5/h), le
  changement de mot de passe (5/15min), la demande de réinitialisation (5/h) et
  les rapports de bug (3/15min)
- Étranglement par compte en plus de celui par IP, vérifié _avant_ le hachage,
  pour qu'une tentative bloquée ne coûte rien au serveur
- Régénération de l'identifiant de session à la connexion (anti-fixation)
- Cookie `httpOnly`, `sameSite=lax`, `secure` dès que le site est en HTTPS
- Invalidation de toutes les sessions d'un compte au changement ou à la
  réinitialisation de son mot de passe, et au changement de rôle
- Jetons de réinitialisation stockés hachés, à usage unique, expirant en 1 heure
- CORS sur liste blanche d'origines
- Sauvegardes dans `/data/backups`

## Droits des personnes

Exercés par simple email à kunelabcontact@duck.com, traités sous un mois.

| Droit                  | Comment il est honoré aujourd'hui                           |
| ---------------------- | ----------------------------------------------------------- |
| Accès, portabilité     | Export manuel depuis la base, à la demande                  |
| Rectification          | Modifiable en ligne, ou à la demande                        |
| Effacement             | `pnpm --filter back admin delete <login>`, voir `eraseUser` |
| Limitation, opposition | Traité à la demande                                         |

> **À faire, sans urgence.** Il n'existe pas de bouton de suppression de compte
> en libre-service, ni d'export automatique. Le RGPD ne l'exige pas tant que les
> demandes sont honorées sous un mois, mais les deux seraient une amélioration
> nette et la commande CLI existe déjà pour l'effacement.

## Violations de données

En cas de violation : notification à la CNIL sous 72 h si elle présente un
risque pour les personnes (art. 33), et information directe des personnes
concernées si le risque est élevé (art. 34). Le contact CNIL et le formulaire
sont sur cnil.fr.
