/* ==========================================================================
   Web map — Réinventer une friche industrielle
   7 Rue Fritz Kiener, Strasbourg

   - maquette BIM (multipatch -> glTF) posée dans un repère ENU géoréférencé
   - menu de niveaux : le changement de niveau ne touche JAMAIS la caméra
   - masque de zonage fonctionnel activable / désactivable
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------- constantes */
  const SERVICES = {
    imagerie:   'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    plan:       'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer',
    etiquettes: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer'
  };

  const FONDS = [
    { id: 'imagerie', libelle: 'Imagerie satellite' },
    { id: 'plan',     libelle: 'Fond topographique' },
    { id: 'aucun',    libelle: 'Aucun fond de plan' }
  ];

  /* ------------------------------------------------------------------ etat */
  const etat = {
    meta: null,
    niveau: 'tous',
    zonage: true,
    fond: 'imagerie',
    bdtopo: true,
    ombres: false
  };

  const D = { modele: {}, masques: {}, etiquettes: {}, fond: {} };
  let viewer = null;
  let versFixe = null;          // matrice ENU -> ECEF, origine du repère local
  let origineCarto = null;
  let pret = false;

  /* état exposé pour les tests automatisés (captures, non-régression) */
  window.__bim = { pret: false, etapes: [], erreurs: [], modeles: {}, camera: null };
  function etape(nom) { window.__bim.etapes.push(nom + ' @' + Date.now()); }

  const $ = function (s) { return document.querySelector(s); };
  const $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ------------------------------------------------------------- utilitaires */
  function dire(texte, erreur) {
    const el = $('#message');
    if (!el) return;
    el.innerHTML = texte;
    el.classList.toggle('erreur', !!erreur);
  }

  function cacherVoile() {
    const v = $('#voile');
    if (!v) return;
    v.classList.add('parti');
    setTimeout(function () { if (v.parentNode) v.parentNode.removeChild(v); }, 620);
  }

  function pointEnu(e, n, u, cible) {
    return Cesium.Matrix4.multiplyByPoint(
      versFixe,
      new Cesium.Cartesian3(e, n, u || 0),
      cible || new Cesium.Cartesian3());
  }

  function centroide(anneau) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < anneau.length; i++) {
      const p = anneau[i], q = anneau[(i + 1) % anneau.length];
      const f = p[0] * q[1] - q[0] * p[1];
      a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
    }
    if (Math.abs(a) < 1e-9) {
      let sx = 0, sy = 0;
      anneau.forEach(function (p) { sx += p[0]; sy += p[1]; });
      return [sx / anneau.length, sy / anneau.length];
    }
    a *= 0.5;
    return [cx / (6 * a), cy / (6 * a)];
  }

  /* ---------------------------------------------------------- textes statiques */
  function appliquerTextes() {
    const m = etat.meta;
    document.title = m.titre + ' — ' + m.sous_titre;
    $('#titre').textContent = m.titre;
    $('#sousTitre').textContent = m.sous_titre;

    const pied = 'Maquette BIM (levé DWG) calée sur la BD TOPO · ' +
                 'Lambert-93 / RGF93 — EPSG:2154 · ' +
                 'Fond de plan © Esri, Maxar, Earthstar Geographics';
    $('#piedTexte').textContent = pied;

    const ul = $('#listeSources');
    m.sources.forEach(function (s) {
      const li = document.createElement('li');
      li.textContent = s;
      ul.appendChild(li);
    });
    $('#noteVerticale').textContent = m.avertissement;
  }

  /* ------------------------------------------------------------------ viewer */
  function creerViewer() {
    viewer = new Cesium.Viewer('cesiumContainer', {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      selectionIndicator: false,
      infoBox: false,
      vrButton: false,
      shouldAnimate: false,
      targetFrameRate: 30,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      requestRenderMode: false
    });

    const scene = viewer.scene;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1220');
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = true;
    scene.fog.enabled = false;
    scene.skyAtmosphere.show = true;
    scene.highDynamicRange = false;

    /* lumière fixe : évite un éclairage nocturne selon l'heure du poste */
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2024-06-21T10:30:00Z');
    viewer.clock.shouldAnimate = false;
    if (scene.light && scene.light.intensity !== undefined) {
      scene.light.intensity = 1.35;
    }

    const ctrl = scene.screenSpaceCameraController;
    ctrl.minimumZoomDistance = 6;
    ctrl.maximumZoomDistance = 1200;
    ctrl.enableCollisionDetection = false;

    /* fond neutre si aucun service n'est joignable */
    scene.globe.show = true;
  }

  async function chargerFonds() {
    async function provider(url) {
      return Cesium.ArcGisMapServerImageryProvider.fromUrl(url);
    }
    try {
      const img = await provider(SERVICES.imagerie);
      D.fond.imagerie = viewer.imageryLayers.addImageryProvider(img);
      D.fond.imagerie.brightness = 1.06;
      D.fond.imagerie.contrast = 1.03;
    } catch (e) {
      console.warn('imagerie indisponible', e);
    }
    try {
      const topo = await provider(SERVICES.plan);
      D.fond.plan = viewer.imageryLayers.addImageryProvider(topo);
      D.fond.plan.show = false;
    } catch (e) {
      console.warn('fond topographique indisponible', e);
    }
    try {
      const lab = await provider(SERVICES.etiquettes);
      D.fond.etiquettes = viewer.imageryLayers.addImageryProvider(lab);
      D.fond.etiquettes.show = true;
    } catch (e) {
      console.warn('étiquettes indisponibles', e);
    }
  }

  /* ------------------------------------------------------------------ modèle */
  /* Cesium applique par défaut aux glTF une correction d'axes composée
     (Y_UP_TO_Z_UP * Z_UP_TO_X_UP) qui, sur un glTF Y-up classique
     (X = est, Y = haut, Z = sud), produit une rotation parasite de 90° en plan.
     On désactive donc sa correction (upAxis Z / forwardAxis X -> identité) et
     on applique nous-mêmes la seule rotation Y-up -> Z-up, ce qui donne
     world = ENU * (X = est, Y = nord, Z = haut). */
  function matriceYVersZ() {
    return Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromRotationX(Cesium.Math.PI_OVER_TWO));
  }

  function creerModele() {
    const yVersZ = matriceYVersZ();
    const placement = Cesium.Matrix4.multiply(versFixe, yVersZ, new Cesium.Matrix4());
    D.placement = placement;

    const promesses = etat.meta.niveaux.map(function (n) {
      return Cesium.Model.fromGltfAsync({
        url: 'data/' + n.glb,
        modelMatrix: placement,
        upAxis: Cesium.Axis.Z,
        forwardAxis: Cesium.Axis.X,
        scale: 1.0,
        show: true,
        shadows: Cesium.ShadowMode.DISABLED,
        allowPicking: false
      }).then(function (modele) {
        modele.id = 'modele-' + n.id;
        viewer.scene.primitives.add(modele);
        D.modele[n.id] = modele;
        window.__bim.modeles[n.id] = { pret: modele.ready, triangles: modele.trianglesLength };
        return modele;
      }).catch(function (e) {
        window.__bim.erreurs.push('glb ' + n.id + ' : ' + e.message);
        console.error('glb ' + n.id, e);
      });
    });
    return Promise.all(promesses);
  }

  /* ------------------------------------------------------ masques de zonage */
  /* NB : pas de `outline` sur les polygones extrudés — le worker Cesium
     PolygonOutlineGeometry plante sur cette configuration. On trace les
     contours avec des polylignes 3D. */
  function contour(positions, couleur, largeur) {
    return viewer.entities.add({
      polyline: {
        positions: positions.concat([positions[0]]),
        width: largeur || 2,
        material: couleur,
        arcType: Cesium.ArcType.NONE
      }
    });
  }

  function creerZones() {
    etat.meta.niveaux.forEach(function (n) {
      const usage = etat.meta.usages[n.usage];
      const couleur = Cesium.Color.fromCssColorString(usage.couleur);
      const anneau = (n.zones && n.zones[0]) ? n.zones[0] : null;
      if (!anneau) return;

      const base = anneau.map(function (p) { return pointEnu(p[0], p[1], 0); });
      const sol = anneau.map(function (p) { return pointEnu(p[0], p[1], n.u_sol); });
      const toit = anneau.map(function (p) { return pointEnu(p[0], p[1], n.u_toit); });

      /* volume translucide du niveau */
      const volume = viewer.entities.add({
        id: 'zone-' + n.id,
        show: true,
        polygon: {
          hierarchy: base,
          height: n.u_sol,
          extrudedHeight: n.u_toit,
          material: couleur.withAlpha(0.28),
          closeTop: false,
          closeBottom: false
        }
      });

      /* dalle de lecture au niveau du plancher */
      const dalle = viewer.entities.add({
        id: 'dalle-' + n.id,
        show: true,
        polygon: {
          hierarchy: base,
          height: n.u_sol + 0.03,
          material: couleur.withAlpha(0.17)
        }
      });

      const cSol = contour(sol, couleur.withAlpha(0.95), 2);
      const cToit = contour(toit, couleur.withAlpha(0.55), 1.4);

      /* étiquette de zone */
      const c = centroide(anneau);
      const etiquette = viewer.entities.add({
        id: 'etiq-' + n.id,
        show: true,
        position: pointEnu(c[0], c[1], (n.u_sol + n.u_toit) / 2),
        label: {
          text: n.code + '  ' + usage.label_fr,
          font: '600 15px "Segoe UI", system-ui, -apple-system, sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: couleur.withAlpha(0.95),
          outlineWidth: 5,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(40, 1.0, 420, 0.55)
        }
      });

      D.masques[n.id] = [volume, dalle, cSol, cToit];
      D.etiquettes[n.id] = etiquette;
    });
  }

  /* ---------------------------------------------------------- emprise BD TOPO */
  async function creerBdtopo() {
    const ref = etat.meta.reference;
    if (!ref || !ref.fichier) return;
    try {
      const geo = await fetch('data/' + ref.fichier).then(function (r) { return r.json(); });
      const f = geo.features[0];
      const plat = [];
      f.geometry.coordinates[0].forEach(function (p) { plat.push(p[0], p[1]); });
      D.bdtopo = viewer.entities.add({
        id: 'ref-bdtopo',
        name: 'BD TOPO — ' + f.properties.source,
        show: true,
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(plat),
          material: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.09),
          height: 0.05
        }
      });
      D.bdtopoContour = contour(
        (function () {
          const pos = [];
          for (let i = 0; i < plat.length; i += 2) {
            pos.push(Cesium.Cartesian3.fromDegrees(plat[i], plat[i + 1], 0.08));
          }
          return pos;
        })(),
        Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.95), 2);
    } catch (e) {
      console.warn('emprise BD TOPO indisponible', e);
    }
  }

  /* -------------------------------------------------------------------- vue */
  function vueInitiale() {
    const c = etat.meta.camera;
    /* sur écran étroit le panneau occupe le bas : on vise plus bas pour que la
       maquette reste dans la partie visible, sans changer l'angle de vue */
    const etroit = window.matchMedia('(max-width: 860px)').matches;
    const vise = etroit ? c.u - c.distance_m * 0.28 : c.u;
    const cible = pointEnu(c.e, c.n, vise);
    viewer.camera.lookAt(cible, new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(c.heading_deg),
      Cesium.Math.toRadians(c.pitch_deg),
      c.distance_m));
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  /* vue verticale : sert au contrôle d'alignement des masques
     (pitch strictement à -90 rend le cap indéfini : on reste à -89 max) */
  function vueDessus(distance, cap, inclinaison) {
    const c = etat.meta.camera;
    const cible = pointEnu(c.e, c.n, c.u);
    viewer.camera.lookAt(cible, new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(cap === undefined ? 0 : cap),
      Cesium.Math.toRadians(inclinaison === undefined ? -89 : inclinaison),
      distance || 130));
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  /* --------------------------------------------------------------- interface */
  function bouton(id, code, nom, couleur, zh) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');

    const c = document.createElement('span');
    c.className = 'code';
    c.textContent = code;
    b.appendChild(c);

    const t = document.createElement('span');
    t.className = 'nom';
    t.textContent = nom + (zh ? ' · ' + zh : '');
    b.appendChild(t);

    if (couleur) {
      const p = document.createElement('span');
      p.className = 'pastille';
      p.style.background = couleur;
      b.appendChild(p);
    }
    return b;
  }

  function construireNiveaux() {
    const zone = $('#listeNiveaux');
    zone.innerHTML = '';
    zone.appendChild(bouton('tous', '⌂', 'Bâtiment complet', null, null));

    const ordre = etat.meta.niveaux.slice().sort(function (a, b) { return b.etage - a.etage; });
    ordre.forEach(function (n) {
      const usage = etat.meta.usages[n.usage];
      zone.appendChild(bouton(n.id, n.code, n.nom_fr, usage.couleur, usage.label_fr));
    });

    zone.addEventListener('click', function (ev) {
      const b = ev.target.closest('button');
      if (!b) return;
      etat.niveau = b.dataset.id;
      appliquerEtat();          /* aucune instruction caméra ici, par choix */
    });
  }

  function construireFonds() {
    const zone = $('#listeFonds');
    zone.innerHTML = '';
    FONDS.forEach(function (f) {
      const b = bouton(f.id, '', f.libelle, null, null);
      b.querySelector('.code').style.display = 'none';
      zone.appendChild(b);
    });
    zone.addEventListener('click', function (ev) {
      const b = ev.target.closest('button');
      if (!b) return;
      etat.fond = b.dataset.id;
      appliquerEtat();
    });
  }

  function construireLegende() {
    const ul = $('#legende');
    ul.innerHTML = '';
    const groupes = {};
    etat.meta.niveaux.forEach(function (n) {
      (groupes[n.usage] = groupes[n.usage] || []).push(n.code);
    });
    Object.keys(groupes).forEach(function (cle) {
      const u = etat.meta.usages[cle];
      const li = document.createElement('li');
      const carre = document.createElement('span');
      carre.className = 'carre';
      carre.style.background = Cesium.Color.fromCssColorString(u.couleur).withAlpha(0.55).toCssColorString();
      carre.style.borderColor = u.couleur;
      li.appendChild(carre);

      const txt = document.createElement('span');
      txt.className = 'txt';
      const fort = document.createElement('strong');
      fort.textContent = u.label_fr;
      txt.appendChild(fort);
      const em = document.createElement('em');
      em.textContent = 'niveaux ' + groupes[cle].join(' · ');
      txt.appendChild(em);
      li.appendChild(txt);
      ul.appendChild(li);
    });
  }

  function appliquerEtat() {
    const tous = etat.niveau === 'tous';

    etat.meta.niveaux.forEach(function (n) {
      const visible = tous || etat.niveau === n.id;
      if (D.modele[n.id]) D.modele[n.id].show = visible;

      const masque = visible && etat.zonage;
      (D.masques[n.id] || []).forEach(function (e) { if (e) e.show = masque; });

      /* les étiquettes de zone ne s'affichent que sur un niveau isolé,
         sinon elles se superposent en projection oblique */
      if (D.etiquettes[n.id]) D.etiquettes[n.id].show = masque && !tous;
    });

    if (D.bdtopo) D.bdtopo.show = etat.bdtopo;
    if (D.bdtopoContour) D.bdtopoContour.show = etat.bdtopo;

    Object.keys(D.fond).forEach(function (k) {
      if (k === 'etiquettes') return;
      D.fond[k].show = (k === etat.fond);
    });
    if (D.fond.etiquettes) D.fond.etiquettes.show = etat.fond !== 'aucun';

    if (viewer) {
      viewer.shadows = etat.ombres;
      etat.meta.niveaux.forEach(function (n) {
        if (D.modele[n.id]) {
          D.modele[n.id].shadows = etat.ombres
            ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
        }
      });
      viewer.scene.requestRender();
    }

    $$('#listeNiveaux button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.id === etat.niveau));
    });
    $$('#listeFonds button').forEach(function (b) {
      b.setAttribute('aria-checked', String(b.dataset.id === etat.fond));
    });
  }

  function brancherCommandes() {
    $('#caseZonage').addEventListener('change', function (e) {
      etat.zonage = e.target.checked;
      appliquerEtat();
    });
    $('#caseBdtopo').addEventListener('change', function (e) {
      etat.bdtopo = e.target.checked;
      appliquerEtat();
    });
    $('#caseOmbres').addEventListener('change', function (e) {
      etat.ombres = e.target.checked;
      appliquerEtat();
    });
    $('#btnVue').addEventListener('click', vueInitiale);
    $('#btnPlein').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      }
    });
    $('#basculePanneau').addEventListener('click', function () {
      const ferme = document.body.classList.toggle('panneau-ferme');
      this.setAttribute('aria-expanded', String(!ferme));
    });
  }

  function replacerPanneau() {
    const entete = $('#entete'), panneau = $('#panneau');
    if (!entete || !panneau) return;
    const etroit = window.matchMedia('(max-width: 860px), (max-height: 620px)').matches;
    if (etroit) {
      panneau.style.top = '';
      panneau.style.maxHeight = '';
      return;
    }
    const haut = entete.offsetTop + entete.offsetHeight + 12;
    panneau.style.top = haut + 'px';
    panneau.style.maxHeight = Math.max(220, window.innerHeight - haut - 18) + 'px';
  }

  /* --------------------------------------------------------------- démarrage */
  async function demarrer() {
    dire('Chargement de la maquette…');

    const reponse = await fetch('data/meta.json', { cache: 'no-cache' });
    if (!reponse.ok) throw new Error('meta.json introuvable (' + reponse.status + ')');
    etat.meta = await reponse.json();

    appliquerTextes();
    creerViewer();
    await chargerFonds();

    origineCarto = Cesium.Cartesian3.fromDegrees(
      etat.meta.origine.lon, etat.meta.origine.lat,
      etat.meta.origine.hauteur_ellipsoide_m || 0);
    versFixe = Cesium.Transforms.eastNorthUpToFixedFrame(origineCarto);

    creerZones();
    await creerBdtopo();

    construireNiveaux();
    construireFonds();
    construireLegende();
    brancherCommandes();
    appliquerEtat();

    vueInitiale();
    replacerPanneau();

    if (window.matchMedia('(max-width: 860px)').matches) {
      document.body.classList.add('panneau-ferme');
    }
    window.addEventListener('resize', replacerPanneau);

    await creerModele();
    pret = true;
    appliquerEtat();
    window.__bim.pret = true;
    window.__bim.camera = {
      longitude: viewer.camera.positionCartographic.longitude * 180 / Math.PI,
      latitude: viewer.camera.positionCartographic.latitude * 180 / Math.PI,
      hauteur: viewer.camera.positionCartographic.height,
      heading: viewer.camera.heading * 180 / Math.PI,
      pitch: viewer.camera.pitch * 180 / Math.PI
    };
    etape('pret');
    cacherVoile();

    /* petite API de contrôle (tests automatisés, captures) */
    window.__bim.api = {
      viewer: function () { return viewer; },
      niveau: function (id) { etat.niveau = id; appliquerEtat(); },
      zonage: function (v) { etat.zonage = !!v; appliquerEtat(); },
      fond: function (id) { etat.fond = id; appliquerEtat(); },
      vueInitiale: vueInitiale,
      vueDessus: vueDessus,
      camera: function () {
        const p = viewer.camera.positionCartographic;
        return {
          longitude: p.longitude * 180 / Math.PI,
          latitude: p.latitude * 180 / Math.PI,
          hauteur: p.height,
          heading: viewer.camera.heading * 180 / Math.PI,
          pitch: viewer.camera.pitch * 180 / Math.PI,
          direction: [viewer.camera.direction.x, viewer.camera.direction.y, viewer.camera.direction.z],
          position: [viewer.camera.position.x, viewer.camera.position.y, viewer.camera.position.z]
        };
      },
      pointEnu: function (e, n, u) {
        const p = pointEnu(e, n, u);
        const c = Cesium.Cartographic.fromCartesian(p);
        return {
          longitude: c.longitude * 180 / Math.PI,
          latitude: c.latitude * 180 / Math.PI,
          hauteur: c.height
        };
      },
      enuDe: function (cart) {
        const inv = Cesium.Matrix4.inverseTransformation(versFixe, new Cesium.Matrix4());
        const p = Cesium.Matrix4.multiplyByPoint(inv, cart, new Cesium.Cartesian3());
        return { e: p.x, n: p.y, u: p.z };
      },
      boiteModele: function (id) {
        const m = D.modele[id];
        if (!m) return null;
        return {
          centre: this.enuDe(m.boundingSphere.center),
          rayon: m.boundingSphere.radius,
          upAxis: m._upAxis !== undefined ? m._upAxis : 'n/a'
        };
      },
      modele: function (id) { return D.modele[id]; },
      cles: function (id) {
        const m = D.modele[id];
        if (!m) return null;
        return Object.getOwnPropertyNames(m).filter(function (k) {
          return /bound|matrix|axis|scale|ready|transform/i.test(k);
        });
      },
      boiteZone: function (id) {
        const masque = D.masques[id];
        if (!masque) return null;
        const pos = masque[0].polygon.hierarchy.getValue(Cesium.JulianDate.now()).positions;
        let e0 = 1e9, e1 = -1e9, n0 = 1e9, n1 = -1e9;
        pos.forEach(function (p) {
          const q = window.__bim.api.enuDe(p);
          e0 = Math.min(e0, q.e); e1 = Math.max(e1, q.e);
          n0 = Math.min(n0, q.n); n1 = Math.max(n1, q.n);
        });
        return { e: [e0, e1], n: [n0, n1] };
      }
    };
  }

  window.addEventListener('error', function (ev) {
    dire('Erreur : ' + (ev.message || 'inconnue'), true);
  });

  demarrer().catch(function (err) {
    console.error(err);
    dire('Impossible de charger la carte.<br>' +
         '<small>' + (err && err.message ? err.message : err) + '</small>', true);
  });
})();
