# Strike Rush

Jeu web multijoueur temps réel destiné à accompagner une partie de bowling physique. La tablette de piste pilote les frames et affiche le lobby, les mises et le podium. Les joueurs rejoignent la partie depuis leur téléphone grâce au QR code.

## Contenu du dépôt

```text
strike-rush/
├── index.html             # Affichage central / tablette
├── player.html            # Interface téléphone
├── CONFIG.js              # Personnalisation centralisée
├── manifest.json          # PWA
├── sw.js                  # Cache du shell applicatif
├── assets/
│   └── icon.svg
├── css/
│   └── app.css
├── js/
│   ├── realtime.js        # Adaptateurs local et Socket.IO
│   ├── tablet.js
│   └── player.js
└── server/
    ├── index.js           # Serveur Socket.IO avec validation
    ├── package.json
    └── render.yaml
```

## Test local immédiat

Le projet démarre en `mode: "local"` dans `CONFIG.js`. Ce mode utilise `BroadcastChannel` et `localStorage`, ce qui permet de tester une tablette et plusieurs joueurs dans différents onglets du même navigateur.

1. Depuis le dossier racine, lancez un serveur statique :

   ```powershell
   python -m http.server 8080
   ```

2. Ouvrez `http://localhost:8080/` pour la tablette.
3. Ouvrez le lien joueur affiché sous le QR code dans un autre onglet.
4. Rejoignez le lobby, démarrez la partie, puis ouvrez une frame.

Le mode local sert uniquement à la démonstration. Pour des téléphones physiques différents, activez Socket.IO.

## Temps réel avec Supabase

La version publique utilise Supabase Realtime. Elle fonctionne entre différents Wi-Fi et réseaux mobiles.

1. Ouvrez le projet Supabase.
2. Ouvrez **SQL Editor > New query**.
3. Copiez tout le contenu de `supabase/schema.sql`.
4. Cliquez sur **Run** une seule fois.
5. Rechargez la tablette Strike Rush et générez un nouveau lobby.

La clé `anon` présente dans `CONFIG.js` est une clé publique prévue pour le navigateur. Ne placez jamais une clé `service_role` dans ce dépôt.

Le schéma :

- limite chaque lobby à 9 joueurs ;
- valide les mises et calcule les gains dans PostgreSQL ;
- protège l’hôte et chaque joueur avec des jetons privés hachés ;
- limite le chat aux phrases autorisées ;
- expire les parties après 24 heures ;
- diffuse les changements avec Supabase Realtime.

## Déploiement du frontend sur GitHub Pages

1. Dans GitHub, ouvrez **Settings > Pages**.
2. Sous **Build and deployment**, sélectionnez **Deploy from a branch**.
3. Sélectionnez la branche `main` et le dossier `/ (root)`.
4. Enregistrez et attendez la fin du déploiement.
5. Ouvrez l’URL fournie, généralement :

   ```text
   https://votre-compte.github.io/strike-rush/
   ```

6. Vérifiez que `CONFIG.js` utilise bien l’URL Render et que `FRONTEND_ORIGIN` autorise votre domaine GitHub Pages.

## Personnalisation

Toutes les valeurs principales sont dans `CONFIG.js` :

- `appName` : nom du jeu ;
- `bowlingName` : nom affiché sur la tablette ;
- `colors` : palette néon ;
- `game.maxPlayers` : joueurs maximum ;
- `game.startingCredits` : crédits de départ ;
- `game.bettingSeconds` : durée de mise ;
- `game.totalFrames` : nombre de frames ;
- `realtime.mode` : `supabase` ou `local` ;
- `realtime.supabaseUrl` : URL publique du projet Supabase ;
- `realtime.supabaseAnonKey` : clé publique `anon`.

Les constantes de sécurité du serveur sont également définies au début de `server/index.js`. Si vous modifiez les limites de mise ou de joueurs dans `CONFIG.js`, reportez les mêmes valeurs côté serveur.

## Exploitation sur tablette

- Ajoutez la page à l’écran d’accueil pour profiter du mode PWA `standalone`.
- Utilisez le bouton plein écran en haut à droite.
- Sur Android, activez l’épinglage d’application pour un kiosk simple.
- Sur iPad, utilisez **Ajouter à l’écran d’accueil**, puis l’accès guidé.
- La musique est coupée par défaut. Aucun son ne démarre sans interaction.

## Règles et sécurité

- Pseudo anonyme de 3 à 12 caractères.
- 1 à 9 joueurs.
- Une mise par joueur et par frame.
- Mise validée et débitée côté serveur.
- Résultat et calcul des gains effectués côté serveur.
- Chat limité à quatre phrases prédéfinies.
- Rate limiting en mémoire sur connexion, mise et chat.
- Aucun paiement, aucune monnaie réelle et aucune publicité.
- Aucun lobby n’est conservé au-delà de 24 heures.
- Les statistiques personnelles finales sont stockées uniquement sur le téléphone.

## Limites connues

- Le QR code est généré par `api.qrserver.com`. Si ce service est indisponible, le lien joueur reste affiché et utilisable.
- Le plan gratuit Render peut introduire un délai au premier réveil.
- Le serveur en mémoire n’est pas conçu pour être répliqué sur plusieurs instances sans adaptateur Redis.
- Le scoring concerne les prédictions Strike Rush, pas le score officiel de bowling.
