# BTP-Vision — Suivi de chantier + probabilités (loi Bêta-PERT / Monte Carlo)

Application de suivi d'un chantier **déjà lancé** : 8 phases, tâches, journal, rapports journaliers, photos,
**comptes séparés par intervenant**, **estimations de durée à 3 valeurs (o, m, p)** et **simulation probabiliste**
de la fin du chantier.
Pile technique : serveur Node.js, interface HTML et base **MySQL** (comptes, projet, estimations, sessions et photos).

```
btp-vision/
├── server.js        serveur : API, base MySQL, comptes, anti-écrasement, simulation
├── pert.js          moteur probabiliste (loi Bêta-PERT, Monte Carlo) — JavaScript pur
├── package.json
├── public/index.html   tout le front (HTML + CSS + JS)
```

## Ce qui a été corrigé / ajouté

| Besoin | Solution |
|---|---|
| Deux personnes modifient en même temps → la dernière écrase l'autre | Chaque enregistrement porte un **n° de version**. Si quelqu'un a enregistré avant vous, le serveur répond « conflit » (409) et le navigateur **fusionne** (tâches par identifiant, journal/rapports/notes cumulés) au lieu d'écraser. Toutes les 6 s, chacun reçoit aussi les changements des autres. |
| Un seul mot de passe admin partagé | **Un compte par intervenant** (mots de passe chiffrés avec scrypt, sessions par cookie HttpOnly). 10 rôles : administrateur, maître d'ouvrage, maître d'œuvre/architecte, BET, bureau de contrôle, conducteur de travaux, chef de chantier, entreprise/sous-traitant, fournisseur, observateur (lecture seule). Le journal, les notes et les rapports indiquent **qui** a fait quoi. |
| Dates fixes | **3 durées par tâche** (bouton ⏱) : optimiste o, probable m, pessimiste p → moyenne (o+4m+p)/6, écart-type (p−o)/6. |
| « 70 % de chances de finir en 15 jours » | Onglet **Simulation** : 5 000 tirages de Monte Carlo (Bêta-PERT), P10/P50/P80/P90, histogramme, **probabilité de finir dans un délai visé**, tâches qui pèsent le plus sur l'incertitude. |

## PARTIE 1 — Lancer sur votre ordinateur
1. Installez **Node.js 22.13 ou plus** (version LTS) et **MySQL 8+** : https://nodejs.org — puis `node -v` doit afficher v22.13+.
2. Créez la base MySQL `btp_vision` et accordez-en l'accès à l'utilisateur configuré. Le fichier [`database.sql`](./database.sql) fournit le schéma complet ; vous pouvez l'exécuter avec `mysql -u root -p < database.sql`. Le serveur crée aussi les tables manquantes au démarrage, mais il ne crée pas la base elle-même : elle doit déjà exister.
3. Copiez `.env.example` vers `.env`, puis renseignez les paramètres de connexion MySQL (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` et `MYSQL_DATABASE=btp_vision`). Vous pouvez aussi utiliser `MYSQL_URL`. Si le fournisseur impose TLS, activez `MYSQL_SSL=true`. Le fichier `.env` est ignoré par Git : ne le partagez pas et remplacez les valeurs d'exemple.
4. Dans le dossier du projet : `npm install`, puis `npm start`.
5. Ouvrez http://localhost:3000.
6. **Premier lancement** : l'écran propose de créer le compte **administrateur**. Faites-le tout de suite.
7. Onglet **Admin** → « Ajouter un intervenant » : créez un compte par personne (identifiant, rôle, mot de passe).

### Remplir la base avec un projet de démonstration
Après création de la base et configuration de `.env`, démarrez l'application dans un terminal et laissez-la tourner. Le serveur crée automatiquement les tables manquantes :

```powershell
npm start
```

Créez un compte admin dans le navigateur, puis lancez le script dans un **deuxième** terminal PowerShell :

```powershell
npm run db:seed-demo
```

Renseignez `BTP_ADMIN_USERNAME` et `BTP_ADMIN_PASSWORD` dans `.env` avec les identifiants de votre administrateur. Le script ajoute le projet de démonstration via l'API et préremplit les estimations PERT des tâches. Il refuse de remplacer un projet existant, sauf si vous ajoutez `-- --force` à la commande. Vous pouvez définir `BTP_BASE_URL` si l'application n'est pas à `http://localhost:3000`.

### Sauvegarder la base MySQL
Avec `.env` configuré, lancez `npm run db:backup` pour créer une sauvegarde SQL complète (tables, données et photos) dans `backups/`. Chaque sauvegarde est restaurée dans une base temporaire pour vérifier qu'elle est lisible et que les nombres d'enregistrements correspondent ; celles de plus de 30 jours sont supprimées après réussite. Le dossier est ignoré par Git et les nouvelles sauvegardes sont accessibles au compte Windows courant, aux administrateurs et au système.

Quand le serveur de l'application reste lancé, il crée aussi automatiquement une sauvegarde chaque jour à 02:00 (heure locale). Si le serveur est arrêté à cette heure, la sauvegarde sera faite au prochain horaire quotidien où il tourne. Pour restaurer manuellement, importez le fichier SQL dans MySQL avec `mysql -u UTILISATEUR -p < backups/NOM_DU_FICHIER.sql`.

### Test rapide (5 min)
1. Connecté en admin : « Explorer avec des données de démo » ou utilisez le script ci-dessus (des durées PERT d'exemple sont créées).
2. Onglet **Simulation** : saisissez un délai visé (ex. 40 jours) → « Calculer ».
3. Ouvrez une 2e fenêtre de navigation privée, connectez-vous avec un autre compte, cochez une tâche : l'autre fenêtre se met à jour en moins de 10 s, **sans rien perdre**.
4. Test d'écrasement : modifiez deux tâches différentes dans les deux fenêtres presque en même temps → les deux modifications sont conservées.

### Problèmes courants
| Message | Solution |
|---|---|
| `Access denied` ou `ECONNREFUSED` | Vérifiez les paramètres de connexion MySQL et que le serveur MySQL est accessible. |
| `Connexion admin refusée` lors du remplissage | Créez d'abord l'administrateur dans le navigateur, puis mettez exactement son identifiant et son mot de passe dans `BTP_ADMIN_USERNAME` et `BTP_ADMIN_PASSWORD` du fichier `.env`. |
| `EADDRINUSE` | Port occupé → `PORT=3001 node server.js` (PowerShell : `$env:PORT=3001; node server.js`) |
| Mot de passe admin oublié | Demandez à un autre admin de le réinitialiser (Admin → Mot de passe). Sans autre admin, réinitialisez le compte directement dans MySQL. |

## PARTIE 2 — Mettre en ligne
Les données du projet et les photos sont enregistrées dans MySQL : aucun volume de disque persistant n'est requis pour les données applicatives. Configurez la connexion avec `MYSQL_URL` ou les variables `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` et `MYSQL_DATABASE`. `PORT` est généralement fournie par l'hébergeur.

> ⚠ Dès que le site est en ligne, **créez immédiatement le compte administrateur** : la toute première personne qui ouvre le site peut le faire.

### Option A — Démo rapide et gratuite depuis votre PC (pour la présentation)
1. Configurez MySQL, installez les dépendances (`npm install`), puis lancez `npm start`.
2. Dans un 2e terminal, avec un outil de tunnel (ex. Cloudflare Tunnel : `cloudflared tunnel --url http://localhost:3000`), vous obtenez une adresse https publique à donner au professeur.
3. Votre PC doit rester allumé et connecté pendant le test ; les données restent dans la base MySQL configurée.

### Option B — Plateforme (Render, Railway, Fly.io…)
1. Mettez le dossier sur GitHub (`git init`, `git add .`, `git commit -m "v1"`, `git push`).
2. Créez un **Web Service** depuis le dépôt : commande de démarrage `npm start`, pas d'étape de build, Node ≥ 22.13.
3. Créez une base MySQL (sur la plateforme ou chez un fournisseur compatible) et renseignez ses variables de connexion dans les variables d'environnement du service.
4. Ouvrez l'URL fournie (HTTPS automatique) → créez le compte admin.

### Option C — Petit serveur (VPS Ubuntu)
1. Louez un serveur Ubuntu, notez l'IP, connectez-vous : `ssh root@VOTRE_IP`.
2. Installez Node 22+ (https://nodejs.org), puis `npm install -g pm2`. Créez ou choisissez une base MySQL.
3. Copiez le projet : `scp -r btp-vision root@VOTRE_IP:/opt/`.
4. Configurez les variables MySQL, exécutez `npm install`, puis lancez `PORT=3000 pm2 start server.js --name btp --update-env && pm2 save && pm2 startup`.
5. HTTPS + nom de domaine : pointez le domaine vers l'IP, installez **Caddy** avec ce `Caddyfile` :
```
votredomaine.com {
    reverse_proxy localhost:3000
}
```

### Sauvegardes (à faire !)
Configurez des sauvegardes régulières de la base MySQL chez votre hébergeur. Les photos sont aussi dans cette base.
Les anciennes données SQLite éventuellement présentes dans `data/` ne sont pas importées automatiquement.

## PARTIE 3 — Comment ça marche (pour l'oral)
- **Données** : un objet `S` (phases → tâches) dans le navigateur. Chaque clic modifie `S`, l'envoie au serveur (`PUT /api/state` avec la version vue), puis redessine l'écran.
- **Anti-écrasement** : `baseVersion` ≠ version du serveur → réponse 409 → fusion à 3 voies (`merge3` dans `index.html`) entre *ce que j'avais chargé*, *ma version*, *la version du serveur*.
- **PERT** : pour une tâche, μ = (o + 4m + p)/6 et σ = (p − o)/6. Pour le chantier : μ = Σμᵢ et σ = √(Σσᵢ²).
- **Monte Carlo** (`pert.js`) : on tire une durée par tâche selon une loi **Bêta-PERT** (α = 1 + 4(m−o)/(p−o), β = 1 + 4(p−m)/(p−o)), on additionne, on recommence 5 000 fois ; les percentiles de ces 5 000 totaux donnent « X % de chances de finir en N jours ».
- **Chantier déjà lancé** : par défaut, seules les tâches **non terminées** sont simulées (case « Tâches restantes seulement »).

### Limites connues (honnêtes)
- La simulation **additionne** les durées (tâches enchaînées, sans chemin critique ni travaux en parallèle) : c'est prudent, mais pessimiste si des équipes travaillent en même temps.
- Les tâches sans durées ne sont pas comptées (un avertissement s'affiche).
- Si deux personnes changent **exactement la même valeur** au même moment, c'est la dernière qui reste ; tout le reste est fusionné.
- Les rôles limitent l'écriture (observateur = lecture seule, gestion des comptes = admin), mais tous les intervenants autorisés à écrire modifient le même projet.
