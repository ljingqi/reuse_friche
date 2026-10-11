# 关于再利用一处工业荒地的设想 — Web map 3D

> **7 Rue F. Kinner à Strasbourg** — reconversion d'une friche industrielle
> Maquette BIM géoréférencée (Lambert-93 / RGF93 — EPSG:2154), lecture par niveau
> et masque de zonage fonctionnel.

Ce dossier est un site **statique** (aucun serveur applicatif, aucune base de
données) : il peut être publié tel quel sur GitHub Pages, Netlify, un intranet,
ou simplement servi par un petit serveur HTTP local.

---

## 1. Contenu

```
web/
├── index.html                 page unique (viewer CesiumJS)
├── css/style.css              mise en page, thème, responsive (PC / tablette)
├── js/app.js                  logique : niveaux, zonage, caméra, fonds de carte
├── data/
│   ├── meta.json              paramètres : titres, origine géographique, niveaux,
│   │                          usages, emprises de zonage, caméra initiale
│   ├── ss1.glb  rdc.glb       un modèle 3D par niveau (glTF binaire)
│   ├── etg1.glb  etg2.glb
│   └── ref_bdtopo.geojson     emprise BD TOPO utilisée pour le calage
├── .nojekyll                  demandé par GitHub Pages
└── README.md
```

Poids total : environ **1,5 Mo**. Aucune dépendance locale : CesiumJS 1.126 est
chargé depuis un CDN (jsDelivr).

---

## 2. Lancer en local

Un serveur HTTP est nécessaire (`fetch()` est bloqué en `file://`) :

```powershell
cd web
python -m http.server 8777
# puis ouvrir http://127.0.0.1:8777/
```

---

## 3. Publier sur GitHub Pages

1. Créer un dépôt **public** sur GitHub, par exemple `friche-kiener-webmap`
   (ne rien initialiser : ni README, ni .gitignore).
2. Depuis ce dossier (`web/`), pousser le contenu **à la racine** du dépôt :

   ```powershell
   git init
   git add .
   git commit -m "Web map 3D - friche industrielle, Strasbourg"
   git branch -M main
   git remote add origin https://github.com/<utilisateur>/<depot>.git
   git push -u origin main
   ```

3. Sur GitHub : **Settings → Pages → Build and deployment**
   - *Source* : `Deploy from a branch`
   - *Branch* : `main`, dossier `/ (root)` → **Save**
4. Attendre 1 à 2 minutes. L'adresse est :

   `https://<utilisateur>.github.io/<depot>/`

Le site est alors accessible depuis un PC **et** une tablette, à la même adresse.
Tous les chemins du projet sont relatifs : le sous-dossier `/<depot>/` ne pose
aucun problème.

> Si une connexion Git demande une authentification, utiliser un
> *Personal Access Token* (Settings → Developer settings) comme mot de passe.

**Variante « dépôt unique »** : si l'on veut garder le projet complet dans un
seul dépôt, placer le contenu de `web/` dans un dossier `docs/` et choisir
`/docs` comme dossier de publication à l'étape 3.

---

## 4. D'où viennent les données affichées

Les fichiers de `data/` sont **générés**, pas écrits à la main :

```powershell
& "C:\Program Files\ArcGIS\Pro\bin\python\envs\arcgispro-py3\python.exe" _work\export_web.py
```

`_work/export_web.py` :

1. lit les solides de la maquette (`_work/BIM_3D_solides.csv` + `_work/obj3d/*.obj`) ;
2. leur applique la transformation de calage enregistrée dans
   `_work/georef_params.json` (rotation **7,10505°**, translation
   **(1050888,413 ; 6841989,874)**, échelle **1,000**, décalage vertical **+139,50 m**) ;
3. convertit le tout dans un repère **ENU** (Est/Nord/Haut) centré sur la
   parcelle, en tenant compte de la **convergence des méridiennes** (−3,4588°) ;
4. écrit un `.glb` par niveau (attributs → un matériau par famille : murs
   extérieurs, murs intérieurs, dalles, escaliers) ;
5. calcule l'enveloppe de chaque niveau (`MultiPatchFootprint` + `Dissolve` +
   `Buffer` de 0,60 m) qui sert de **masque de zonage** ;
6. écrit `meta.json` et `ref_bdtopo.geojson`.

> ⚠️ Le script doit être relancé **après** tout changement de la maquette
> (`_work/build_bim3d.py`), mais **avant** de republier le site.

---

## 5. Commandes de la carte

| Commande | Effet |
|---|---|
| **Niveaux / 楼层** | Affiche un niveau (ou le bâtiment complet). **La caméra ne bouge jamais** lors du changement de niveau. |
| **Afficher le masque de zonage** | Active/désactive les volumes de zonage : **résidentiel** en vert (1er et 2e étage), **commercial et services** en orange (rez-de-chaussée et sous-sol). |
| **Fond de carte** | Imagerie satellite (Esri World Imagery), fond topographique (Esri World Topographic Map) ou aucun fond. |
| **Couches** | Emprise BD TOPO de référence, ombres portées. |
| **Réinitialiser la vue** | Revient au cadrage oblique d'ouverture. |
| **Plein écran** | Passage en plein écran (utile sur tablette). |

Navigation : clic gauche = rotation, clic droit / deux doigts = zoom,
molette = zoom, tactile = pincer/glisser.

---

## 6. Notes techniques

- **Repère** : les modèles sont écrits en glTF **Y-up** classique
  (X = est, Y = haut, Z = sud). CesiumJS 1.126 applique par défaut une
  correction d'axes *composée* (`Y_UP_TO_Z_UP × Z_UP_TO_X_UP`) qui produit une
  rotation parasite de 90° en plan ; elle est donc désactivée
  (`upAxis: Z`, `forwardAxis: X`) et la rotation Y-up → Z-up est appliquée
  explicitement dans `js/app.js` (`matriceYVersZ()`).
- **Altimétrie** : les hauteurs sont relatives, `U = altitude NGF − 139,0 m`
  (sol du site, `altitude_minimale_sol` de la BD TOPO). Aucun modèle numérique
  de terrain n'est chargé : le fond de plan tient lieu de sol.
- **Sous-sol** : le niveau −1 descend à −3,70 m ; il reste visible car
  CesiumJS n'occulte pas les objets situés sous l'ellipsoïde
  (`depthTestAgainstTerrain` désactivé, valeur par défaut).
- **Fond de plan** : Esri World Imagery / World Topographic Map, utilisés sans
  clé d'API. Le géoréférencement de l'imagerie Esri peut différer de quelques
  mètres de celui de la BD TOPO (IGN), qui fait foi ici.
- **Version figée** : CesiumJS 1.126.0 (CDN jsDelivr). Pour figer également le
  CDN, télécharger `Build/Cesium/` dans `vendor/cesium/` et adapter les deux
  balises de `index.html` ainsi que `CESIUM_BASE_URL`.

---

## 7. Sources

- Levé DWG — *interior design, Strasbourg* (`F_RdC_V2`, `F_RdC_V3`).
- BD TOPO 2021 — bâtiment `BATIMENT0000002223298023` (IGN).
- Calage : ajustement rigide sur l'emprise BD TOPO (voir
  `BIM_3D_georeferencement.md`), résidu médian 0,44 m.
- Fond de plan : © Esri, Maxar, Earthstar Geographics.
