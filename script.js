'use strict';

/* =============================================================================
 *  TEAS TRIANGLE v1.0 — ESAA PROJECT — ADALIA By Victor Mulé
 *  - Triangle de solubilité interactif - Outil pour la restauration conservation
 * ========================================================================== */

/* ============================================================================
 * 1) CONFIGURATION GLOBALE
 * ========================================================================== */
const CONFIG = Object.freeze({
  CANVAS: { WIDTH: 860, HEIGHT: 640 },
  TRIANGLE: { SIZE: 6, THICKNESS: 0.15 },
  RENDERING: {
    ANTIALIAS: true,
    SHADOW_MAP_ENABLED: true,
    SPHERE_RADIUS: 0.05,
    SPHERE_SEGMENTS: 16,
    LABEL_OFFSET_Y: 0.18,
    GRID_LINE_STEP: 5,
    Z_OFFSET_BASE: 0.01,
    Z_OFFSET_LAYER: 0.002
  },
  TICKS: { STEP: 10, OFFSET: 0.10, LENGTH: 0.12, LABEL_OFFSET: 0.14, FONT_SIZE: 14 },
  COLORS: {
    BACKGROUND: 0x0c0f14,
    TRIANGLE: 0x1a2332,
    GRID_LINES: 0x3a5277,
    AMBIENT_LIGHT: 0xffffff,
    DIRECTIONAL_LIGHT: 0xffffff,
    LABEL_TEXT: '#e6eef6',
    SOLVENTS: [[255,213,107],[255,107,107],[124,196,255],[120,224,143],[255,160,122],[200,160,255]],
    POLYMERS: [[255,140,207],[255,200,0],[0,220,200],[190,255,120]],
    MIX: [124,196,255]
  },
  LIGHTING: { AMBIENT_INTENSITY: 0.4, DIRECTIONAL_INTENSITY: 0.8, DIRECTIONAL_POSITION: [5,5,5] },
  CAMERA: { Z_MIN: 3.5, Z_MAX: 12, INITIAL_Z: 6, WHEEL_STEP: 0.6 },
  MATH: { SQRT3: Math.sqrt(3), SAMPLING_POINTS: 120 },
  INTERACTION: { MAX_TILT: 0.35, ROLL_MAX: 0.15, DAMPING: 0.12, HOVER_RADIUS: 0.25 }
});


/* ============================================================================
 * 2) DATA MANAGER
 *    - Chargement solvants, matrice de miscibilité, polymères
 *    - Accès TEAS (fd,fp,fh) et conversions δD/δP/δH
 *    - Recherche des solvants proches (distance TEAS)
 * ========================================================================== */
class DataManager {
  constructor() {
    this.solvents = [];
    this.misc = new Map();
    this.polymers = [];
    this.meanDPHSum = 30;
  }

  async load() {
    const [solvRes, miscRes, polyRes] = await Promise.all([
      fetch('./solvants.json'),
      fetch('./miscibilite_matrix.csv'),
      fetch('./polymeres.json').catch(() => null) 
    ]);

    // Solvants + miscibilité (obligatoires)
    this.solvents = await solvRes.json();
    this.misc = this.parseMiscCSV(await miscRes.text());

    // Polymères (optionnel)
    this.polymers = [];
    if (polyRes && polyRes.ok) {
      try {
        this.polymers = await polyRes.json();
      } catch (_) {
        this.polymers = [];
      }
    }

    // Estimation (moyenne) de (D+P+H) sur la base solvants → utile pour TEAS→δ
    const sums = this.solvents
      .map(s => [s.D, s.P, s.H])
      .filter(t => t.every(Number.isFinite))
      .map(([D, P, H]) => D + P + H);

    if (sums.length) {
      this.meanDPHSum = sums.reduce((a, b) => a + b, 0) / sums.length;
    }
  }

  parseMiscCSV(csv) {
    const lines = (csv || '').trim().split(/\r?\n/);
    if (lines.length < 2) return new Map();
    const sep = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(sep).map(s => s.trim()).slice(1);
    const table = new Map();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep).map(s => s.trim());
      if (!cols[0]) continue;
      const rowName = cols[0];
      const row = new Map();
      for (let j = 1; j < cols.length && j <= headers.length; j++) {
        const v = (cols[j] || '').toLowerCase();
        const ok = ['1', 'true', 'yes', 'y', 'oui'].includes(v);
        row.set(headers[j - 1], ok);
      }
      table.set(rowName, row);
    }
    return table;
  }

  getSolvents() { return this.solvents; }
  getPolymers() { return this.polymers; }
  getMisc() { return this.misc; }

  /** Fractions TEAS (fd/fp/fh en 0..100) pour un solvant.
   *  Si fd/fp/fh manquent, on projette via ratios (D,P,H).
   */
  getTeasFractions(solvent) {
    let { fd, fp, fh } = solvent || {};
    const hasFd = Number.isFinite(fd), hasFp = Number.isFinite(fp), hasFh = Number.isFinite(fh);
    if (hasFd && hasFp && hasFh) return { fd, fp, fh };
    const { D, P, H } = solvent || {};
    if ([D, P, H].every(Number.isFinite)) {
      const sum = D + P + H || 1;
      return { fd: 100 * D / sum, fp: 100 * P / sum, fh: 100 * H / sum };
    }
    return null;
  }

  /** TEAS → δ (approx via somme moyenne observée sur la base) */
  teasToDelta(fd, fp, fh) {
    const S = this.meanDPHSum || 30;
    return { D: S * (fd / 100), P: S * (fp / 100), H: S * (fh / 100) };
  }

  /** k solvants les plus proches d’un point TEAS (distance euclidienne en fd/fp/fh) */
  findNearestByTeas(target, k = 3) {
    const t = this.getTeasFractions(target) || target;
    const dist2 = (A, B) => {
      const a = this.getTeasFractions(A) || A;
      const b = this.getTeasFractions(B) || B;
      const dx = a.fd - b.fd, dy = a.fp - b.fp, dz = a.fh - b.fh;
      return dx * dx + dy * dy + dz * dz;
    };
    return this.solvents
      .map(s => ({ name: s.name, tea: this.getTeasFractions(s) }))
      .filter(o => !!o.tea)
      .map(o => ({ ...o, d2: dist2(o.tea, t) }))
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, k)
      .map(o => ({ name: o.name, fd: o.tea.fd, fp: o.tea.fp, fh: o.tea.fh, dist: Math.sqrt(o.d2) }));
  }
}


/* ============================================================================
 * 3) MATH UTILS
 *    - Conversion TEAS ↔ XY
 *    - Enveloppe convexe (pour zones polymères / liens)
 * ========================================================================== */
class MathUtils {
  static normalize(fd, fp, fh) {
    const s = fd + fp + fh;
    return s ? { fd: fd/s, fp: fp/s, fh: fh/s } : { fd: 0, fp: 0, fh: 0 };
  }

  /** TEAS → XY (triangle centré, base horizontale) */
  static teasToXY(fd, fp, fh) {
    const n = MathUtils.normalize(fd, fp, fh);
    return {
      x: (n.fd + 0.5 * n.fp - 0.5) * CONFIG.TRIANGLE.SIZE,
      y: ((CONFIG.MATH.SQRT3 / 2) * n.fp - CONFIG.MATH.SQRT3 / 6) * CONFIG.TRIANGLE.SIZE
    };
  }

  /** XY → TEAS (%) — inverse analytique de la projection */
  static xyToTeas(x, y) {
    const size = CONFIG.TRIANGLE.SIZE;
    const fp = (2 * y / (size * CONFIG.MATH.SQRT3)) + 1/3;
    const fd = (x / size) + 0.5 - 0.5 * fp;
    const fh = 1 - fd - fp;
    return { fd: fd * 100, fp: fp * 100, fh: fh * 100 };
  }

  /** Enveloppe convexe 2D (monotone chain) */
  static convexHull(pts) {
    if (pts.length <= 1) return [...pts];
    const arr = [...pts].sort((a,b)=> a.x===b.x ? a.y-b.y : a.x-b.x);
    const cross = (o,a,b)=> (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
    const lower = [];
    for (const p of arr) {
      while (lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i=arr.length-1;i>=0;i--) {
      const p = arr[i];
      while (upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0,-1).concat(upper.slice(0,-1));
  }
}


/* ============================================================================
 * 4) SELECTION MANAGER — Sélections UI (solvants/polymères)
 * ========================================================================== */
class SelectionManager {
  constructor() {
    this.solvents = []; // {id,index,color,select,linked}
    this.polymers = []; // {id,index,color,select}
    this._sid = 1; this._pid = 1;
  }
  addSolvent(index,color,select) {
    const cur = this.solvents.find(s=>s.select===select);
    if (cur) { cur.index=index; cur.color=[...color]; }
    else this.solvents.push({ id:this._sid++, index, color:[...color], select, linked:false });
  }
  setSolventLinked(select, linked) {
    const s = this.solvents.find(x=>x.select===select);
    if (s) s.linked = !!linked;
  }
  removeSolventBySelect(select) {
    const i = this.solvents.findIndex(s=>s.select===select);
    if (i!==-1) this.solvents.splice(i,1);
  }
  addPolymer(index,color,select) {
    const cur = this.polymers.find(p=>p.select===select);
    if (cur) { cur.index=index; cur.color=[...color]; }
    else this.polymers.push({ id:this._pid++, index, color:[...color], select });
  }
  removePolymerBySelect(select) {
    const i = this.polymers.findIndex(p=>p.select===select);
    if (i!==-1) this.polymers.splice(i,1);
  }
}


/* ============================================================================
 * 5) UI BUILDER — Composants de sélection (solvant/polymère)
 * ========================================================================== */
class UIBuilder {
  static createSelector(container, dataList, palette, onChange, options={}) {
    const wrap = document.createElement('div'); wrap.className='selector';
    const header = this._header();
    const select = this._select(dataList);
    const color = palette[container.children.length % palette.length];
    select.style.color = `rgb(${color.join(',')})`;
    const headerContent = header.querySelector('.selector-header');
    headerContent.appendChild(select);

    if (options.linkable) {
      const link = this._linkToggle((checked)=> options.onLinkToggle?.(checked, select));
      headerContent.appendChild(link);
    }
    if (options.removable) {
      const close = this._closeBtn(()=> options.onRemove?.(select, wrap));
      headerContent.appendChild(close);
    }

    wrap.appendChild(header);
    const kind = options.kind || 'solvent'; 
    if (kind === 'polymer') wrap.classList.add('polymer'); 
    const info = this._info(kind);
    wrap.appendChild(info);
    container.appendChild(wrap);

    this._setupToggle(header, wrap);
    this._setupSelect(select, dataList, info, color, onChange, kind);  
    return { element: wrap, select, color };
  }

  static _header() {
    const h = document.createElement('div');
    const c = document.createElement('div'); c.className='selector-header';
    const chev = document.createElement('button'); chev.className='chev';
    chev.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 10l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    c.appendChild(chev); h.appendChild(c); return h;
  }
  static _select(list) {
    const s = document.createElement('select');
    list.forEach((item,i)=>{
      const o = document.createElement('option');
      o.value = i; o.textContent = item.name || `Item ${i}`; s.appendChild(o);
    });
    return s;
  }

  static _linkToggle(onChange) {
    const label = document.createElement('label');
    label.className='link-toggle';
    const cb = document.createElement('input'); cb.type='checkbox';
    cb.addEventListener('change',()=>onChange(cb.checked));
    const span = document.createElement('span'); span.textContent='Relier';
    label.appendChild(cb); label.appendChild(span); return label;
  }
  static _closeBtn(onClick) {
    const b = document.createElement('button'); b.type='button'; b.className='selector-close'; b.textContent='×';
    b.addEventListener('click', onClick); return b;
  }

static _info(kind = 'solvent') {
  const info = document.createElement('div');
  info.className = 'info';

  // ====== HEAD ======
  const gHead = document.createElement('div');
  gHead.className = 'info-group head';

  if (kind === 'polymer') {
    const cas = document.createElement('div');
    cas.className = 'cas-text';
    cas.dataset.kv = 'CAS';
    gHead.appendChild(cas);
  } else {
    const formula = document.createElement('div');
    formula.className = 'formula-text';
    formula.dataset.kv = 'formula';
    const cas = document.createElement('div');
    cas.className = 'cas-text';
    cas.dataset.kv = 'CAS';
    gHead.appendChild(formula);
    gHead.appendChild(cas);
  }

  const sep1 = document.createElement('hr');
  sep1.className = 'info-sep';

  // ====== CORE : fd/fp/fh + δD/δP/δH ======
  const gCore = document.createElement('div');
  gCore.className = 'info-group core';
  const r1 = document.createElement('div');
  r1.className = 'row param-grid';
  r1.innerHTML = '<div data-kv="fd"></div><div data-kv="fp"></div><div data-kv="fh"></div>';
  const r2 = document.createElement('div');
  r2.className = 'row param-grid';
  r2.innerHTML = '<div data-kv="D"></div><div data-kv="P"></div><div data-kv="H"></div>';
  gCore.appendChild(r1);
  gCore.appendChild(r2);

  const sep2 = document.createElement('hr');
  sep2.className = 'info-sep';

  // ====== PHYS ======
  const gPhys = document.createElement('div');
  gPhys.className = 'info-group phys';

  if (kind === 'polymer') {
    const rTg = document.createElement('div');
    rTg.className = 'row param-grid';
    rTg.innerHTML = '<div data-kv="Tg_C" style="grid-column:1/-1"></div>';

    const split = document.createElement('hr');
    split.className = 'info-sep poly-split';
    
    const rComp = document.createElement('div');
    rComp.className = 'row param-grid';
    rComp.innerHTML = '<div data-kv="composition" style="grid-column:1/-1"></div>';

    const rNote = document.createElement('div');
    rNote.className = 'row param-grid';
    rNote.innerHTML = '<div data-kv="note" style="grid-column:1/-1"></div>';

    gPhys.appendChild(rTg);
    gPhys.appendChild(split);
    gPhys.appendChild(rComp);
    gPhys.appendChild(rNote);
  } else {
    
    // Solvant : V + Tb
    const r3 = document.createElement('div');
    r3.className = 'row param-grid';
    r3.innerHTML = '<div data-kv="V"></div><div data-kv="Tb_C"></div>';
    gPhys.appendChild(r3);
  }

  // Assemblage
  info.appendChild(gHead);
  info.appendChild(sep1);
  info.appendChild(gCore);
  info.appendChild(sep2);
  info.appendChild(gPhys);
  return info;
}


  static _setupToggle(header, wrap) {
    const chev = header.querySelector('.chev');
    const toggle = ()=> wrap.classList.toggle('collapsed');
    chev.addEventListener('click', toggle);
    header.addEventListener('dblclick', toggle);
  }
  
static _setupSelect(select, list, info, color, onChange, kind = 'solvent') {
  const update = (i) => {
    const item = list[i]; if (!item) return;
    UIBuilder._fill(info, item, kind);
    onChange(i, color, select);
  };
  select.addEventListener('change', e => update(Number(e.target.value)));
  update(0);
}

static _fill(info, item, kind = 'solvent') {
  const set = (k, text) => {
    const el = info.querySelector(`[data-kv="${k}"]`);
    if (el) el.textContent = text;
  };

  // Commun : TEAS & δ
  let { fd, fp, fh } = item || {};
  if (![fd, fp, fh].every(Number.isFinite) && [item.D, item.P, item.H].every(Number.isFinite)) {
    const s = (item.D + item.P + item.H) || 1;
    fd = 100 * item.D / s; fp = 100 * item.P / s; fh = 100 * item.H / s;
  }
  set('fd', `fd=${Number.isFinite(fd) ? fd.toFixed(1) : ''}`);
  set('fp', `fp=${Number.isFinite(fp) ? fp.toFixed(1) : ''}`);
  set('fh', `fh=${Number.isFinite(fh) ? fh.toFixed(1) : ''}`);
  set('D',  `δD=${Number.isFinite(item.D) ? item.D.toFixed(1) : ''}`);
  set('P',  `δP=${Number.isFinite(item.P) ? item.P.toFixed(1) : ''}`);
  set('H',  `δH=${Number.isFinite(item.H) ? item.H.toFixed(1) : ''}`);

  if (kind === 'polymer') {
    const cas = item.CAS ?? item.cas;
    set('CAS', `CAS: ${cas || 'N/A'}`);

    // Tg + composition + note
    set('Tg_C', Number.isFinite(item.Tg_C) ? `Tg=${item.Tg_C} °C` : 'Tg=');
    set('composition', item.composition ? `Composition: ${item.composition}` : 'Composition: —');
    set('note', item.note ? `Note: ${item.note}` : 'Note: —');

    // (pas de formule, pas de V, pas de Tb)
  } else {
    // Solvants
    set('formula', `Formule: ${item.formula || 'N/A'}`);
    set('CAS', `CAS: ${item.CAS || 'N/A'}`);
    set('V', Number.isFinite(item.V) ? `V=${item.V.toFixed(1)} cm³/mol` : 'V=');
    set('Tb_C', Number.isFinite(item.Tb_C) ? `Tb=${item.Tb_C} °C` : 'Tb=');
  }
}
}


/* ============================================================================
 * 6) RENDERER 3D — Scène, triangle, points, interactions
 * ========================================================================== */
class TeasRenderer3D {
  constructor(selMgr, dataMgr) {
    this.selMgr = selMgr;
    this.dataMgr = dataMgr;

    // Three.js
    this.scene = null; this.camera = null; this.renderer = null;
    this.triangleGroup = null;

    // Objets et états
    this.solventPoints = []; // {mesh,data}
    this.solventLabels = [];
    this.polymerRegions = [];
    this.linkGroup = null;

    // Interactions
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.pointerInside = false;
    this.isMouseOver = false;
    this.showSolventLabels = false;

    // HUD et tooltips
    this.cornerHUD = null;
    this.tipMain = null; this.tipSub = null;

    // Points cliqués (sphères rouges)
    this.picks = new Map(); // id -> { sphere, teas }
    this._pickId = 1;
    this._onPick = null; // callback fournie par l’App

    // Points de mélange
    this.mixObjects = new Map(); // id -> { sphere, label, lastTeas, linked }

    this.init();
  }

  /* ---------- Initialisation scène ---------- */
  init() {
    const container = document.getElementById('threejs-holder');

    // Scène & caméra
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(CONFIG.COLORS.BACKGROUND);

    this.camera = new THREE.PerspectiveCamera(
      75, CONFIG.CANVAS.WIDTH/CONFIG.CANVAS.HEIGHT, 0.1, 1000
    );
    this.camera.position.set(0, 0.5, CONFIG.CAMERA.INITIAL_Z);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: CONFIG.RENDERING.ANTIALIAS });
    this.renderer.setSize(CONFIG.CANVAS.WIDTH, CONFIG.CANVAS.HEIGHT);
    this.renderer.shadowMap.enabled = CONFIG.RENDERING.SHADOW_MAP_ENABLED;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    // Contenu & UI
    this._lighting();
    this._triangle();
    this._tooltip();
    this._cornerHUD();
    this._events();
    this.animate();
  }

  /* ---------- Eclairage ---------- */
  _lighting() {
    const amb = new THREE.AmbientLight(CONFIG.COLORS.AMBIENT_LIGHT, CONFIG.LIGHTING.AMBIENT_INTENSITY);
    this.scene.add(amb);
    const dir = new THREE.DirectionalLight(CONFIG.COLORS.DIRECTIONAL_LIGHT, CONFIG.LIGHTING.DIRECTIONAL_INTENSITY);
    dir.position.set(...CONFIG.LIGHTING.DIRECTIONAL_POSITION);
    dir.castShadow = true;
    this.scene.add(dir);
  }

  /* ---------- Construction du triangle extrudé + grille + graduations ---------- */
  _triangle() {
    this.triangleGroup = new THREE.Group();
    this.scene.add(this.triangleGroup);

    // Base extrudée
    const size = CONFIG.TRIANGLE.SIZE, t = CONFIG.TRIANGLE.THICKNESS;
    const shape = new THREE.Shape();
    shape.moveTo(-size/2, -size*CONFIG.MATH.SQRT3/6);
    shape.lineTo( size/2, -size*CONFIG.MATH.SQRT3/6);
    shape.lineTo( 0,     size*CONFIG.MATH.SQRT3/3);
    shape.closePath();

    const extr = new THREE.ExtrudeGeometry(shape, { depth:t, bevelEnabled:true, bevelThickness:0.01, bevelSize:0.01, bevelSegments:2 });
    const mat  = new THREE.MeshLambertMaterial({ color: CONFIG.COLORS.TRIANGLE, transparent:true, opacity:0.5 });
    const tri  = new THREE.Mesh(extr, mat);
    tri.position.z = -t/2; tri.castShadow = true; tri.receiveShadow = true;
    this.triangleGroup.add(tri);

    // Stocker pour le raycast
    this.triMesh = tri;
    tri.userData.type = 'base';

    // Grille
    const matLine = new THREE.LineBasicMaterial({ color: CONFIG.COLORS.GRID_LINES, transparent:true });
    matLine.depthWrite = false;
    for (let k=CONFIG.RENDERING.GRID_LINE_STEP; k<=95; k+=CONFIG.RENDERING.GRID_LINE_STEP) {
      const v = k/100;
      const groups = [
        [this.teasTo3D(100*v,0,100*(1-v)), this.teasTo3D(100*v,100*(1-v),0)],
        [this.teasTo3D(0,100*v,100*(1-v)), this.teasTo3D(100*(1-v),100*v,0)],
        [this.teasTo3D(0,100*(1-v),100*v), this.teasTo3D(100*(1-v),0,100*v)]
      ];
      groups.forEach(pts=>{
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(g, matLine); line.renderOrder=0;
        line.position.z = CONFIG.TRIANGLE.THICKNESS/2 + 0.001;
        this.triangleGroup.add(line);
      });
    }

    // Graduations & labels de côtés
    this._ticks();
    this._sideLabels();
  }

  _ticks() {
    const { STEP, OFFSET, LENGTH, LABEL_OFFSET, FONT_SIZE } = CONFIG.TICKS;
    const tickMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent:true, depthWrite:false });

    const size = CONFIG.TRIANGLE.SIZE, h = CONFIG.MATH.SQRT3*size/2;
    const A = new THREE.Vector2(-size/2, -h/3);
    const B = new THREE.Vector2( size/2, -h/3);
    const C = new THREE.Vector2( 0,  2*h/3);
    const center = new THREE.Vector2(0,0);

    const sideInfo = (P,Q,rot)=>{
      const dir = Q.clone().sub(P).normalize();
      let n = new THREE.Vector2(-dir.y, dir.x);
      const mid = P.clone().add(Q).multiplyScalar(0.5);
      if (n.dot(mid.clone().sub(center)) < 0) n.multiplyScalar(-1);
      return { p: t=>P.clone().lerp(Q,t), n, rot };
    };
    const sides = [
      sideInfo(A,B,0),
      sideInfo(B,C,-Math.PI/3),
      sideInfo(C,A, Math.PI/3)
    ];

    const make = (pt,n,value,rot)=>{
      const z = CONFIG.TRIANGLE.THICKNESS/2 + 0.085;
      const s = new THREE.Vector3(pt.x + n.x*OFFSET, pt.y + n.y*OFFSET, z);
      const e = new THREE.Vector3(s.x + n.x*LENGTH, s.y + n.y*LENGTH, z);
      const geom = new THREE.BufferGeometry().setFromPoints([s,e]);
      const line = new THREE.Line(geom, tickMat); line.renderOrder=4;
      this.triangleGroup.add(line);
      const labelPos = new THREE.Vector3(e.x + n.x*LABEL_OFFSET, e.y + n.y*LABEL_OFFSET, z);
      const sprite = this._textSprite(String(value), { boxed:false, fontSize:FONT_SIZE, textColor:'#ffffff' });
      sprite.position.copy(labelPos); sprite.material.rotation = rot;
      this.triangleGroup.add(sprite);
    };

    sides.forEach(s=>{
      for (let v=0; v<=100; v+=STEP) make(s.p(v/100), s.n, v, s.rot);
    });
  }

  _sideLabels() {
    const size = CONFIG.TRIANGLE.SIZE, h = CONFIG.MATH.SQRT3*size/2;
    const z = CONFIG.TRIANGLE.THICKNESS/2 + 0.31;
    const sides = [
      { label:'Fd', mid: new THREE.Vector2(0, -h/2.5), rot:0 },
      { label:'Fp', mid: new THREE.Vector2(size/3, h/5), rot:-Math.PI/3 },
      { label:'Fh', mid: new THREE.Vector2(-size/3, h/5), rot: Math.PI/3 }
    ];
    sides.forEach(s=>{
      const outward = s.mid.clone().normalize().multiplyScalar(CONFIG.TICKS.OFFSET+CONFIG.TICKS.LENGTH+CONFIG.TICKS.LABEL_OFFSET);
      const p = new THREE.Vector3(s.mid.x+outward.x, s.mid.y+outward.y, z);
      const sprite = this._textSprite(s.label, { boxed:false, fontSize:22, textColor:'#ffffff' });
      sprite.position.copy(p); sprite.material.rotation = s.rot;
      this.triangleGroup.add(sprite);
    });
  }

  /* ---------- Utilitaires d’affichage ---------- */
  _textSprite(text, opts={}) {
    const { boxed=false, fontSize=22, fixedWidth=180, fixedHeight=48, paddingX=12, paddingY=8, bgColor='rgba(119,22,87,0.85)', borderColor='#33425f', borderRadius=10, borderWidth=2, textColor='#ffffff' } = opts;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${fontSize}px Arial`;
    let cw,ch;
    if (boxed) { cw=fixedWidth; ch=fixedHeight; } else {
      const m = ctx.measureText(text); const tw = Math.ceil(m.width); const th = fontSize+4;
      cw = tw + paddingX*2; ch = th + paddingY*2;
    }
    canvas.width=cw; canvas.height=ch; ctx.font = `${fontSize}px Arial`;
    if (boxed) {
      ctx.fillStyle=bgColor; ctx.strokeStyle=borderColor; ctx.lineWidth=borderWidth;
      const w=cw,h=ch,r=borderRadius;
      ctx.beginPath();
      ctx.moveTo(r,0); ctx.arcTo(w,0,w,h,r); ctx.arcTo(w,h,0,h,r); ctx.arcTo(0,h,0,0,r); ctx.arcTo(0,0,w,0,r);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle=textColor; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text, cw/2, ch/2);
    const tex = new THREE.CanvasTexture(canvas); tex.minFilter=THREE.LinearFilter; tex.magFilter=THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map:tex, transparent:true });
    mat.depthTest=false; mat.depthWrite=false;
    const sprite = new THREE.Sprite(mat);
    const aspect = cw/ch, worldH = boxed?0.35:0.28, worldW = worldH*aspect;
    sprite.scale.set(worldW, worldH, 1); sprite.renderOrder=3; return sprite;
  }

  teasTo3D(fd,fp,fh, z=CONFIG.RENDERING.Z_OFFSET_BASE) {
    const pos = MathUtils.teasToXY(fd,fp,fh);
    const baseZ = CONFIG.TRIANGLE.THICKNESS/2;
    return new THREE.Vector3(pos.x, pos.y, baseZ + z);
  }

  /* ---------- Tooltips & HUD ---------- */
  _tooltip() {
    this.tipMain = document.createElement('div');
    this.tipMain.className = 'tooltip';
    this.tipMain.style.display = 'none';
    document.body.appendChild(this.tipMain);

    this.tipSub = document.createElement('div');
    this.tipSub.className = 'tooltip tooltip--sub';
    this.tipSub.style.display = 'none';
    document.body.appendChild(this.tipSub);
  }

  _cornerHUD() {
    const holder = document.getElementById('threejs-holder');
    this.cornerHUD = document.createElement('div');
    this.cornerHUD.className = 'hud-corner';
    this.cornerHUD.textContent = 'fd=—   fp=—   fh=—';
    holder.appendChild(this.cornerHUD);
  }

  /* ---------- Evénements (souris, molette, resize, clic) ---------- */
  _events() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('mouseenter', ()=> { this.pointerInside = true; });
    canvas.addEventListener('mouseleave', ()=> {
      this.pointerInside = false; this.isMouseOver=false;
      this._hideTip(); this._updateCornerHUD(null);
    });

    canvas.addEventListener('mousemove', (e)=>{
      this._mousePos(e, canvas);
      this._hoverState();
      this._tooltipUpdate(e);
      this._updateCornerHUD(e);
    });

    // Zoom molette
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = Math.sign(e.deltaY);
      const nextZ = this.camera.position.z + dir * CONFIG.CAMERA.WHEEL_STEP;
      this._setZoom(nextZ);
    }, { passive: false });

    // Clic = point rouge + callback App
canvas.addEventListener('click', (e) => {
  this.raycaster.setFromCamera(this.mouse, this.camera);
  const hit = this.raycaster.intersectObject(this.triMesh, true)[0];
  if (!hit) return;

  const pLocal = hit.point.clone();
  this.triangleGroup.worldToLocal(pLocal);

  const teas = MathUtils.xyToTeas(pLocal.x, pLocal.y);
  const eps = 1e-3;
  if (teas.fd < -eps || teas.fp < -eps || teas.fh < -eps) return;

  const id = this._pickId++;
  const defaultName = `Point #${id}`;
  const obj = this._makePickSphere(pLocal.x, pLocal.y, id, defaultName);
  this.picks.set(id, { ...obj, teas, name: defaultName });

  if (typeof this._onPick === 'function') this._onPick(id, teas);
});

    // Resize
    window.addEventListener('resize', ()=> this._resize());
  }

  _mousePos(e, canvas) {
    const r = canvas.getBoundingClientRect();
    this.mouse.x = ((e.clientX - r.left)/r.width)*2 - 1;
    this.mouse.y = -((e.clientY - r.top)/r.height)*2 + 1;
  }
  _hoverState() {
    const d = Math.hypot(this.mouse.x, this.mouse.y);
    this.isMouseOver = d < CONFIG.INTERACTION.HOVER_RADIUS;
  }

  // Tooltip prioritaire sur sphères (mix/solvant), sinon polymères, sinon rien
  _tooltipUpdate(e) {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.triangleGroup.children, true);

const hitSphere = hits.find(h => {
  const t = h.object?.userData?.type;
  return t === 'mix' || t === 'solvent' || t === 'pick'; // 👈 ajout 'pick'
});

    const polys = [];
    const seen = new Set();
    for (const h of hits) {
      const ud = h.object?.userData;
      if (ud?.type === 'polymerRegion' && ud.name && !seen.has(ud.name)) {
        seen.add(ud.name);
        polys.push({ name: ud.name, rgb: ud.rgb });
      }
    }

    if (hitSphere) {
      const mainHTML = this._escapeHTML(hitSphere.object.userData.name);
      const subHTML = polys.length
        ? polys.map(p =>
            `<span class="color-dot" style="background:rgb(${(p.rgb||[200,200,200]).join(',')})"></span>${this._escapeHTML(p.name)}`
          ).join('<br>')
        : null;
      this._showTipPair({ mainHTML, subHTML, e });
      this.renderer.domElement.style.cursor = 'pointer';
      return;
    }

    if (polys.length) {
      const mainHTML = polys.map(p => this._escapeHTML(p.name)).join('<br>');
      this._showTipPair({ mainHTML, subHTML: null, e });
      this.renderer.domElement.style.cursor = 'default';
      return;
    }

    this._hideTip();
    this.renderer.domElement.style.cursor = 'default';
  }

  _showTipPair({ mainHTML, subHTML, e }) {
    const x = e.clientX + 10;
    const y = e.clientY - 30;

    if (mainHTML) {
      this.tipMain.innerHTML = mainHTML;
      this.tipMain.style.display = 'block';
      this.tipMain.style.left = x + 'px';
      this.tipMain.style.top  = y + 'px';
    } else {
      this.tipMain.style.display = 'none';
    }

    if (subHTML) {
      this.tipSub.innerHTML = subHTML;
      this.tipSub.style.display = 'block';
      const r = this.tipMain.getBoundingClientRect();
      this.tipSub.style.left = x + 'px';
      this.tipSub.style.top  = (r.bottom + 6) + 'px';
    } else {
      this.tipSub.style.display = 'none';
    }
  }

  _hideTip() {
    if (this.tipMain) this.tipMain.style.display = 'none';
    if (this.tipSub)  this.tipSub.style.display  = 'none';
  }

  _escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, m => (
      {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]
    ));
  }

  /* ---------- HUD bas-gauche (fd/fp/fh à la souris) ---------- */
  _updateCornerHUD() {
    if (!this.cornerHUD || !this.triMesh) return;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = this.raycaster.intersectObject(this.triMesh, true)[0];

    if (!hit) {
      this.cornerHUD.textContent = 'fd=—   fp=—   fh=—';
      return;
    }

    const pLocal = hit.point.clone();
    this.triangleGroup.worldToLocal(pLocal);
    const { fd, fp, fh } = MathUtils.xyToTeas(pLocal.x, pLocal.y);
    const eps = 1e-3;
    if (fd >= -eps && fp >= -eps && fh >= -eps) {
      this.cornerHUD.textContent =
        `fd=${fd.toFixed(1)}   fp=${fp.toFixed(1)}   fh=${fh.toFixed(1)}`;
    } else {
      this.cornerHUD.textContent = 'fd=—   fp=—   fh=—';
    }
  }

  /* ---------- Sphère rouge (point cliqué) ---------- */
_makePickSphere(x, y, id, name) {
  const z = CONFIG.TRIANGLE.THICKNESS/2 + 0.12;

  // sphère
  const geo = new THREE.SphereGeometry(0.08, 16, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0x220000 });
  const sphere = new THREE.Mesh(geo, mat);
  sphere.position.set(x, y, z);
  sphere.renderOrder = 6;
  sphere.userData = { type:'pick', name };
  this.triangleGroup.add(sphere);

  // label (sprite) - suit l’état showSolventLabels
  const label = this._textSprite(name);
  label.position.set(x, y + CONFIG.RENDERING.LABEL_OFFSET_Y, z);
  label.visible = this.showSolventLabels;
  this.triangleGroup.add(label);

  return { sphere, label };
}

removePick(id) {
  const p = this.picks.get(id);
  if (!p) return;
  if (p.sphere) {
    p.sphere.parent?.remove(p.sphere);
    p.sphere.geometry?.dispose?.();
    p.sphere.material?.dispose?.();
  }
  if (p.label) {
    p.label.parent?.remove(p.label);
    p.label.material?.map?.dispose?.();
    p.label.material?.dispose?.();
  }
  this.picks.delete(id);
}


  /* ---------- Affichage des labels (solvants + mixes) ---------- */
updateLabelVisibility() {
  // labels solvants
  for (const lbl of this.solventLabels) if (lbl) lbl.visible = this.showSolventLabels;
  // labels mixes
  for (const o of this.mixObjects.values()) if (o.label) o.label.visible = this.showSolventLabels;
  // labels des points cliqués
  for (const p of this.picks.values()) if (p.label) p.label.visible = this.showSolventLabels;
}

/** Renomme un mix existant et met à jour son label 3D */
renameMix(id, newName) {
  const o = this.mixObjects.get(id);
  if (!o) return;
  const name = (newName || '').trim() || `Mélange #${id}`;
  o.name = name;
  if (o.sphere) o.sphere.userData.name = name;

  // remplace le sprite texte
  if (o.label) {
    const lp = o.label.position.clone();
    o.label.parent?.remove(o.label);
    o.label.material?.map?.dispose?.();
    o.label.material?.dispose?.();
    const label = this._textSprite(name);
    label.visible = this.showSolventLabels;
    label.position.copy(lp);
    this.triangleGroup.add(label);
    o.label = label;
  }
}

/** Renomme le point cliqué (UI) + met à jour le label 3D */
renamePick(id, newName) {
  const p = this.picks.get(id);
  if (!p) return;

  p.name = newName;
  
  if (p.sphere) p.sphere.userData.name = newName;

  // remplace le sprite de texte
  if (p.label) {
    const pos = p.label.position.clone();
    p.label.parent?.remove(p.label);
    p.label.material?.map?.dispose?.();
    p.label.material?.dispose?.();
  }
  const z = CONFIG.TRIANGLE.THICKNESS/2 + 0.12;
  const label = this._textSprite(newName);
  label.position.set(p.sphere.position.x, p.sphere.position.y + CONFIG.RENDERING.LABEL_OFFSET_Y, z);
  label.visible = this.showSolventLabels;
  this.triangleGroup.add(label);
  p.label = label;
}

toggleSolventLabels() {
  this.showSolventLabels = !this.showSolventLabels;
  this.updateLabelVisibility();
}

  /* ---------- Zoom & resize ---------- */
  _clampZoom(z) {
    return Math.min(CONFIG.CAMERA.Z_MAX, Math.max(CONFIG.CAMERA.Z_MIN, z));
  }
  _setZoom(z) {
    const c = this._clampZoom(z);
    this.camera.position.z = c;
    if (typeof this.onZoomChange === 'function') {
      const t = (c - CONFIG.CAMERA.Z_MIN) / (CONFIG.CAMERA.Z_MAX - CONFIG.CAMERA.Z_MIN);
      this.onZoomChange(t);
    }
  }
  setZoomNormalized(t01) {
    const z = CONFIG.CAMERA.Z_MIN + t01 * (CONFIG.CAMERA.Z_MAX - CONFIG.CAMERA.Z_MIN);
    this._setZoom(z);
  }
  _resize() {
    const container = document.getElementById('threejs-holder');
    const w = container.clientWidth || CONFIG.CANVAS.WIDTH;
    const h = container.clientHeight || CONFIG.CANVAS.HEIGHT;
    this.camera.aspect = w/h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w,h);
  }

  /* ---------- Animation (respiration du triangle) ---------- */
  animate() {
    requestAnimationFrame(()=>this.animate());
    let tx=0,ty=0,tz=0;
    if (this.pointerInside && !this.isMouseOver) {
      ty = this.mouse.x * CONFIG.INTERACTION.MAX_TILT * 2;
      tx = -this.mouse.y * CONFIG.INTERACTION.MAX_TILT * 2;
      tz = this.mouse.x * CONFIG.INTERACTION.ROLL_MAX * 0.5;
    }
    const d = CONFIG.INTERACTION.DAMPING;
    this.triangleGroup.rotation.x += (tx - this.triangleGroup.rotation.x)*d;
    this.triangleGroup.rotation.y += (ty - this.triangleGroup.rotation.y)*d;
    this.triangleGroup.rotation.z += (tz - this.triangleGroup.rotation.z)*d;
    this.renderer.render(this.scene,this.camera);
  }

  /* ---------- Solvants & Polymères (dessin) ---------- */
  refresh() {
    this._solvents();
    this._polymers();
    this.updateLinkedLines();
  }

  _solvents() {
    // Clear
    [...this.solventPoints, ...this.solventLabels].forEach(o=> this.triangleGroup.remove(o.mesh||o));
    this.solventPoints = []; this.solventLabels = [];

    // Add
    for (const sel of this.selMgr.solvents) {
      const solv = this.dataMgr.getSolvents()[sel.index]; if (!solv) continue;
      const teas = this.dataMgr.getTeasFractions(solv); if (!teas) continue;
      const pos = this.teasTo3D(teas.fd, teas.fp, teas.fh, 0.1);

      const geo = new THREE.SphereGeometry(CONFIG.RENDERING.SPHERE_RADIUS, CONFIG.RENDERING.SPHERE_SEGMENTS, CONFIG.RENDERING.SPHERE_SEGMENTS);
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(sel.color[0]/255, sel.color[1]/255, sel.color[2]/255) });
      const sp = new THREE.Mesh(geo, mat);
      sp.position.copy(pos); sp.renderOrder=2;
      sp.userData = { type:'solvent', name: solv.name };
      this.triangleGroup.add(sp);
      this.solventPoints.push({ mesh: sp, data: solv });

      // Label
      const label = this._textSprite(solv.name);
      label.position.copy(pos); label.position.y += CONFIG.RENDERING.LABEL_OFFSET_Y;
      label.visible = this.showSolventLabels;
      this.triangleGroup.add(label);
      this.solventLabels.push(label);
    }
  }

  _polymers() {
    // Remove old
    this.polymerRegions.forEach(r=> this.triangleGroup.remove(r.mesh));
    this.polymerRegions = [];

    for (const sel of this.selMgr.polymers) {
      const poly = this.dataMgr.getPolymers()[sel.index]; if (!poly) continue;
      const { D,P,H,R0 } = poly;
      if (![D,P,H,R0].every(Number.isFinite)) continue;

      const samples = this._sampleHansen(D,P,H,R0);
      const pts3 = samples.map(s=> this.teasTo3D(s.fd,s.fp,s.fh));
      const pts2 = pts3.map(p=> ({x:p.x,y:p.y}));
      const hull = MathUtils.convexHull(pts2);
      if (hull.length<3) continue;

      const shape = new THREE.Shape(); shape.moveTo(hull[0].x, hull[0].y);
      hull.slice(1).forEach(pt=> shape.lineTo(pt.x, pt.y));
      const geom = new THREE.ShapeGeometry(shape);

      const sum = D+P+H || 1;
      const center3 = this.teasTo3D(100*D/sum, 100*P/sum, 100*H/sum);
      const center2 = new THREE.Vector2(center3.x, center3.y);
      const mat = this._gradMat(sel.color, center2, hull);

      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.z = CONFIG.TRIANGLE.THICKNESS/2 + 0.1;
      mesh.renderOrder=1;
      mesh.userData = { type:'polymerRegion', name: poly.name };
      this.triangleGroup.add(mesh);
      this.polymerRegions.push({ mesh, center2 });
    }
  }

  _sampleHansen(D0,P0,H0,R0, n=CONFIG.MATH.SAMPLING_POINTS) {
    const out=[]; const phi = Math.PI*(3-Math.sqrt(5));
    for (let i=0;i<n;i++) {
      const y = 1 - (i/(n-1))*2, r = Math.sqrt(1-y*y), th = phi*i;
      const x = Math.cos(th)*r, z = Math.sin(th)*r;
      const D=Math.max(0,D0+R0*x), P=Math.max(0,P0+R0*y), H=Math.max(0,H0+R0*z);
      const s = D+P+H || 1;
      out.push({ fd:100*D/s, fp:100*P/s, fh:100*H/s });
    }
    return out;
  }

  _gradMat(rgb, center2D, hull) {
    const color = new THREE.Color(rgb[0]/255, rgb[1]/255, rgb[2]/255);
    const rMax = Math.max(...hull.map(p=>Math.hypot(p.x-center2D.x, p.y-center2D.y))) || 1;
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor:{value:color}, uAlphaCenter:{value:0.35}, uAlphaEdge:{value:0.05},
        uCenter:{value:center2D.clone()}, uRMax:{value:rMax}
      },
      vertexShader: `
        varying vec2 vPos;
        void main(){ vPos=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
      `,
      fragmentShader: `
        uniform vec3 uColor; uniform float uAlphaCenter; uniform float uAlphaEdge;
        uniform vec2 uCenter; uniform float uRMax; varying vec2 vPos;
        void main(){
          float d=length(vPos-uCenter);
          float t=clamp(d/uRMax,0.0,1.0);
          float a=mix(uAlphaCenter,uAlphaEdge,smoothstep(0.0,1.0,t));
          gl_FragColor=vec4(uColor,a);
        }
      `,
      transparent:true, depthWrite:false, side:THREE.DoubleSide
    });
  }

  /* ---------- Liens “relier” (hull ou segment) ---------- */
  updateLinkedLines() {
    if (this.linkGroup) { this.triangleGroup.remove(this.linkGroup); this.linkGroup=null; }
    const points = [];

    // solvants cochés "relier"
    for (const sel of this.selMgr.solvents) {
      if (!sel.linked) continue;
      const solv = this.dataMgr.getSolvents()[sel.index]; if (!solv) continue;
      const teas = this.dataMgr.getTeasFractions(solv); if (!teas) continue;
      const p = this.teasTo3D(teas.fd, teas.fp, teas.fh, 0.13);
      points.push({ x:p.x, y:p.y, z:p.z, rgb: sel.color });
    }
    // points de mélange cochés "relier"
    for (const [,o] of this.mixObjects.entries()) {
      if (!o.linked || !o.lastTeas) continue;
      const p = this.teasTo3D(o.lastTeas.fd, o.lastTeas.fp, o.lastTeas.fh, 0.13);
      points.push({ x:p.x, y:p.y, z:p.z, rgb: CONFIG.COLORS.MIX });
    }

    if (points.length < 2) return;

    this.linkGroup = new THREE.Group(); this.triangleGroup.add(this.linkGroup);
    const avg = (arr)=> Math.round(arr.reduce((a,b)=>a+b,0)/arr.length);
    const lineColor = new THREE.Color(
      avg(points.map(p=>p.rgb[0]))/255,
      avg(points.map(p=>p.rgb[1]))/255,
      avg(points.map(p=>p.rgb[2]))/255
    );
    const mat = new THREE.LineBasicMaterial({ color: lineColor, transparent:true, opacity:0.95, depthWrite:false });

    if (points.length >= 3) {
      const hull = MathUtils.convexHull(points.map(p=>({x:p.x,y:p.y})));
      if (hull.length >= 3) {
        const z = points[0].z;
        const verts = hull.map(h=> new THREE.Vector3(h.x,h.y,z));
        const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(verts), mat);
        loop.renderOrder=5; this.linkGroup.add(loop);
        return;
      }
    }
    // fallback: simple segment entre minX/maxX
    const sorted = [...points].sort((a,b)=> a.x-b.x);
    const seg = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(sorted[0].x, sorted[0].y, sorted[0].z),
      new THREE.Vector3(sorted[sorted.length-1].x, sorted[sorted.length-1].y, sorted[sorted.length-1].z)
    ]), mat);
    seg.renderOrder=5; this.linkGroup.add(seg);
  }

  /* ---------- Mix points (sphères bleutées) ---------- */
upsertMixPoint(id, teas, opts = {}) {
  let o = this.mixObjects.get(id);
  const color = CONFIG.COLORS.MIX;
  const pos = this.teasTo3D(teas.fd, teas.fp, teas.fh, 0.12);

  // nom à utiliser : priorité aux opts.name puis au nom déjà stocké, sinon défaut
  const providedName = opts.name || opts.label;
  const defaultName  = `Mélange #${id}`;
  const newName      = providedName || o?.name || defaultName;

  if (!o) {
    // création
    const geo = new THREE.SphereGeometry(0.12, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color[0]/255, color[1]/255, color[2]/255) });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.userData = { type: 'mix', name: newName };
    this.triangleGroup.add(sphere);

    const label = this._textSprite(newName);
    label.visible = this.showSolventLabels;
    this.triangleGroup.add(label);

    o = { sphere, label, lastTeas: null, linked: false, name: newName };
    this.mixObjects.set(id, o);
  } else {
    // mise à jour du nom si fourni
    if (providedName && providedName !== o.name) {
      o.name = providedName;
      if (o.sphere) o.sphere.userData.name = providedName;
      // remplace le sprite pour refléter le nouveau texte
      if (o.label) {
        const lp = o.label.position.clone();
        o.label.parent?.remove(o.label);
        o.label.material?.map?.dispose?.();
        o.label.material?.dispose?.();
        const label = this._textSprite(providedName);
        label.visible = this.showSolventLabels;
        label.position.copy(lp);
        this.triangleGroup.add(label);
        o.label = label;
      }
    }
  }

  // position et état
  o.sphere.position.copy(pos);
  o.label.position.copy(pos);
  o.label.position.y += CONFIG.RENDERING.LABEL_OFFSET_Y;
  o.lastTeas = teas;
  if (typeof opts.linked === 'boolean') o.linked = opts.linked;
}


  removeMixPoint(id) {
    const o = this.mixObjects.get(id);
    if (!o) return;
    if (o.sphere) {
      o.sphere.parent?.remove(o.sphere);
      o.sphere.geometry?.dispose?.();
      o.sphere.material?.dispose?.();
    }
    if (o.label) {
      o.label.parent?.remove(o.label);
      o.label.material?.map?.dispose?.();
      o.label.material?.dispose?.();
    }
    this.mixObjects.delete(id);
  }

  setMixLinked(id, linked) {
    const o = this.mixObjects.get(id); if (o) o.linked = !!linked;
  }

  /* ---------- Callback onPick (branchée par App) ---------- */
  set onPick(fn) { this._onPick = fn; }
  get onPick()   { return this._onPick; }
}


/* ============================================================================
 * 7) LEGEND — Affiche les badges des items sélectionnés
 * ========================================================================== */
class LegendManager {
  constructor(selMgr, dataMgr) {
    this.selMgr = selMgr; this.dataMgr = dataMgr;
    this.el = document.getElementById('legend');
  }
  refresh() {
    if (!this.el) return;
    this.el.innerHTML='';
    // solvants
    for (const sel of this.selMgr.solvents) {
      const solv = this.dataMgr.getSolvents()[sel.index]; if (!solv) continue;
      const b = document.createElement('div'); b.className='badge';
      
      this.el.appendChild(b);
    }
    // polymères
    for (const sel of this.selMgr.polymers) {
      const poly = this.dataMgr.getPolymers()[sel.index]; if (!poly) continue;
      const b = document.createElement('div'); b.className='badge';
      
      this.el.appendChild(b);
    }
  }
}


/* ============================================================================
 * 8) MIXES — Modèle + UI
 * ========================================================================== */
class MixManager {
  constructor() { this.list=[]; this._id=1; }
  add() {
  const m = {
    id: this._id++,
    name: `Mélange #${this._id - 1}`, // 👈 nom par défaut
    rows: [],
    linked: false,
    cardEl: null,
    statusEl: null
  };
  this.list.push(m);
  return m;
}
  remove(mix) { const i=this.list.findIndex(x=>x===mix); if (i!==-1) this.list.splice(i,1); }
}

class MixUIManager {
  constructor(mixMgr, dataMgr, callbacks={}) {
    this.mixMgr = mixMgr; this.dataMgr = dataMgr;
    this.onMixChanged = callbacks.onMixChanged || (()=>{});
    this.onMixRemoved = callbacks.onMixRemoved || (()=>{});
    this.onLinkToggled = callbacks.onLinkToggled || (()=>{});
    this.onMixRenamed = callbacks.onMixRenamed || (() => {});
  }

  createMixUI() {
    const holder = document.getElementById('solventBlock');
    const mix = this.mixMgr.add();
    const card = this._card(mix);
    mix.cardEl = card;
    holder.appendChild(card);

    const rows = card.querySelector('.mix-rows');
    this._addRow(mix, rows, { percent:50 });
    this._addRow(mix, rows, { percent:50 });

    this._updateStatus(mix);
    this._update3D(mix);
    this._enforceSingleUnlocked(mix);
    return mix;
  }

  /* ---------- Carte mélange ---------- */
  _card(mix) {
    const card = document.createElement('div'); card.className='selector mix-card';

    const head = document.createElement('div');
    const headC = document.createElement('div'); headC.className='selector-header';
    const chev = document.createElement('button'); chev.className='chev';
    chev.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 10l4 4 4-4"/></svg>`;
    chev.addEventListener('click', ()=> card.classList.toggle('mix-collapsed'));

    const title = document.createElement('h4'); // visuellement proche des picks
    title.className = "editable-title";
    title.textContent = mix.name || `Mélange #${mix.id}`;
    title.style.cursor = 'text';
    title.title = 'Cliquer pour renommer';

/* — Renommage inline (contentEditable) — */
const enableEdit = () => {
  title.contentEditable = 'true';
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(title);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  title.focus();
};
const commitEdit = () => {
  title.contentEditable = 'false';
  let newName = (title.textContent || '').trim() || `Mélange #${mix.id}`;
  if (newName.length > 12) newName = newName.slice(0, 12); // 👈 coupe à 12
  title.textContent = newName;
  mix.name = newName;
  this.onMixRenamed(mix, newName);
};
title.addEventListener('click', enableEdit);
title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
  else if (e.key === 'Escape') { e.preventDefault(); title.blur(); }
});
title.addEventListener('blur', commitEdit);


    const link = UIBuilder._linkToggle(checked=>{ mix.linked = checked; this.onLinkToggled(mix); });

    const status = document.createElement('span'); status.className='mix-status'; mix.statusEl = status;

    const close = UIBuilder._closeBtn(()=>{ card.remove(); this.mixMgr.remove(mix); this.onMixRemoved(mix); });

    headC.appendChild(chev); headC.appendChild(title); headC.appendChild(link); headC.appendChild(status); headC.appendChild(close);
    head.appendChild(headC); card.appendChild(head);

    const rows = document.createElement('div'); rows.className='mix-rows'; card.appendChild(rows);

    const actions = document.createElement('div'); actions.className='mix-actions';
    const addRow = document.createElement('button'); addRow.className='btn'; addRow.textContent='+ solvant';
    addRow.addEventListener('click', ()=> this._addRow(mix, rows));
    actions.appendChild(addRow); card.appendChild(actions);

    // Pied d'info : fd/fp/fh + δD/δP/δH
    const summary = document.createElement('div');
    summary.className = 'mix-summary';
    summary.innerHTML = `
      <div class="row param-grid">
        <div data-kv="fd"></div>
        <div data-kv="fp"></div>
        <div data-kv="fh"></div>
      </div>
  <div class="row param-grid">
    <div data-kv="D"></div>
    <div data-kv="P"></div>
    <div data-kv="H"></div>
  </div>
        <div class="row param-grid">
    <div data-kv="V"></div> 
  </div>`;
  
    card.appendChild(summary);
    mix.summaryEl = summary;

    const note = document.createElement('div');
note.className = 'mix-note';
note.textContent = 'Calcule linéaire prédictif - résultat approximatif';
card.appendChild(note);

mix.noteEl = note;

    return card;
  }

  /* ---------- Lignes d’un mélange ---------- */
  _addRow(mix, container, preset={}) {
    const row = document.createElement('div'); row.className='mix-row';

    // HEAD
    const head = document.createElement('div'); head.className='mix-row-head';
    const sel = document.createElement('select');
    this.dataMgr.getSolvents().forEach((s,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=s.name; sel.appendChild(o); });
    if (typeof preset.solvIndex==='number') sel.value = String(preset.solvIndex);
    const del = UIBuilder._closeBtn(()=>{
      const idx = mix.rows.indexOf(mixRow); if (idx!==-1) mix.rows.splice(idx,1);
      row.remove(); this._normalizeAfterRemoval(mix); this._renderPercents(mix); this._updateStatus(mix); this._update3D(mix); this._enforceSingleUnlocked(mix);
    });
    head.appendChild(sel); head.appendChild(del);

    // CONTROLS
    const controls = document.createElement('div'); controls.className='mix-row-controls';
    const slider = document.createElement('input'); slider.type='range'; slider.min='0'; slider.max='100'; slider.value=String(preset.percent ?? 0);
    const pct = document.createElement('div'); pct.className='pct'; pct.textContent = `${slider.value} %`;
    const lock = document.createElement('button'); lock.className='lock-btn'; lock.setAttribute('aria-pressed','false'); lock.textContent='🔒';

    controls.appendChild(slider); controls.appendChild(pct); controls.appendChild(lock);
    row.appendChild(head); row.appendChild(controls); container.appendChild(row);

    const mixRow = { solvIndex: Number(sel.value), percent: Number(slider.value), locked:false, rowEl:row, sel, slider, pct, lock };
    mix.rows.push(mixRow);

    const setLockedUI = ()=> {
      slider.disabled = mixRow.locked || this._isSingleUnlocked(mix, mixRow);
      lock.setAttribute('aria-pressed', mixRow.locked?'true':'false');
    };

    sel.addEventListener('change', ()=>{ mixRow.solvIndex = Number(sel.value); this._updateStatus(mix); this._update3D(mix); });
    slider.addEventListener('input', ()=>{
      if (mixRow.locked || this._isSingleUnlocked(mix, mixRow)) return;
      mixRow.percent = Number(slider.value);
      this._redistribute(mix, mixRow);
      this._renderPercents(mix);
      this._updateStatus(mix);
      this._enforceSingleUnlocked(mix);
      this._update3D(mix);
    });
    lock.addEventListener('click', ()=>{
      mixRow.locked = !mixRow.locked; setLockedUI();
      this._redistribute(mix);
      this._renderPercents(mix);
      this._updateStatus(mix);
      this._enforceSingleUnlocked(mix);
      this._update3D(mix);
    });

    // Initial
    this._redistribute(mix);
    this._renderPercents(mix);
    this._updateStatus(mix);
    this._enforceSingleUnlocked(mix);
    this._update3D(mix);
  }

  /* ---------- Répartition / normalisation % ---------- */
  _renderPercents(mix) {
    mix.rows.forEach(r=>{
      r.slider.value = String(r.percent);
      r.pct.textContent = `${r.percent} %`;
    });
  }

  _redistribute(mix, changed=null) {
    const locked = mix.rows.filter(r=>r.locked);
    const unlocked = mix.rows.filter(r=>!r.locked);

    // Tous verrouillés : renormalise à 100
    if (unlocked.length===0) {
      const sum = locked.reduce((a,r)=>a+r.percent,0) || 1;
      locked.forEach(r=> r.percent = Math.round(100*r.percent/sum));
      let diff = 100 - locked.reduce((a,r)=>a+r.percent,0);
      for (const r of locked) { if (!diff) break; r.percent += (diff>0?1:-1); diff += (diff>0?-1:+1); }
      return;
    }

    let totalLocked = locked.reduce((a,r)=>a+r.percent,0);
    if (totalLocked>100) totalLocked=100;
    let remaining = 100 - totalLocked;

    let base = unlocked;
    let fixed = 0;
    if (changed && !changed.locked) {
      fixed = Math.max(0, Math.min(remaining, changed.percent));
      remaining -= fixed;
      base = unlocked.filter(r=> r!==changed);
    }

    const n = base.length;
    const each = n>0 ? Math.floor(remaining/n) : 0;
    let leftover = remaining - each*n;
    base.forEach(r=> r.percent = each);
    if (changed && !changed.locked) changed.percent = fixed;
    for (const r of base) { if (!leftover) break; r.percent += 1; leftover--; }
  }

  _normalizeAfterRemoval(mix) {
    if (mix.rows.length===0) return;
    const locked = mix.rows.filter(r=>r.locked);
    let totalLocked = locked.reduce((a,r)=>a+r.percent,0);
    if (totalLocked>100) totalLocked=100;
    const unlocked = mix.rows.filter(r=>!r.locked);
    const share = unlocked.length ? Math.floor((100-totalLocked)/unlocked.length) : 0;
    let rem = 100 - totalLocked - share*unlocked.length;
    unlocked.forEach(r=> r.percent = share);
    for (const r of unlocked) { if (!rem) break; r.percent += 1; rem--; }
  }

  _isSingleUnlocked(mix, candidate) {
    const u = mix.rows.filter(r=>!r.locked);
    return (u.length===1 && u[0]===candidate);
  }
  _enforceSingleUnlocked(mix) {
    const u = mix.rows.filter(r=>!r.locked);
    const only = (u.length===1)?u[0]:null;
    mix.rows.forEach(r=> r.slider.disabled = r.locked || (only===r));
  }

  /* ---------- Statut miscibilité + projection 3D ---------- */
  _updateStatus(mix) {
    const matrix = this.dataMgr.getMisc();
    const solvs = this.dataMgr.getSolvents();
    let ok = true;
    for (let i=0;i<mix.rows.length;i++) {
      for (let j=i+1;j<mix.rows.length;j++) {
        const a = solvs[mix.rows[i].solvIndex]?.name;
        const b = solvs[mix.rows[j].solvIndex]?.name;
        if (!a || !b) continue;
        const row = matrix.get(a);
        if (row && row.get(b) === false) { ok=false; break; }
      }
      if (!ok) break;
    }
    if (mix.statusEl) {
      mix.statusEl.textContent = ok ? 'Faisable' : 'Non miscible';
      mix.statusEl.className = 'mix-status ' + (ok ? 'ok' : 'warn');
    }
  }

  _computeTeas(mix) {
    if (!mix.rows.length) return null;
    const solvs = this.dataMgr.getSolvents();
    let sumW = 0, fd=0, fp=0, fh=0;
    for (const r of mix.rows) {
      const s = solvs[r.solvIndex]; if (!s) continue;
      const t = this.dataMgr.getTeasFractions(s); if (!t) continue;
      const w = Math.max(0, r.percent || 0);
      fd += t.fd * w; fp += t.fp * w; fh += t.fh * w; sumW += w;
    }
    if (sumW<=0) return null;
    return { fd: fd/sumW, fp: fp/sumW, fh: fh/sumW };
  }

  _computeDelta(mix) {
    if (!mix.rows.length) return null;
    const solvs = this.dataMgr.getSolvents();
    let sumW = 0, D=0, P=0, H=0;
    for (const r of mix.rows) {
      const s = solvs[r.solvIndex]; if (!s) continue;
      const w = Math.max(0, r.percent || 0);
      if (Number.isFinite(s.D)) D += s.D * w;
      if (Number.isFinite(s.P)) P += s.P * w;
      if (Number.isFinite(s.H)) H += s.H * w;
      sumW += w;
    }
    if (sumW<=0) return null;
    return { D: D/sumW, P: P/sumW, H: H/sumW };
  }

  _renderSummary(mix) {
    const teas = this._computeTeas(mix);
    const del  = this._computeDelta(mix);
    const Vmix = this._computeVolume(mix);
    const set = (k, text) => {
      const el = mix.summaryEl?.querySelector(`[data-kv="${k}"]`);
      if (el) el.textContent = text;
    };
    
    if (teas) {
      set('fd', `fd=${teas.fd.toFixed(1)}`);
      set('fp', `fp=${teas.fp.toFixed(1)}`);
      set('fh', `fh=${teas.fh.toFixed(1)}`);
    } else {
      set('fd','fd='); set('fp','fp='); set('fh','fh=');
    }
    if (del) {
    set('D', `δD=${del.D.toFixed(1)}`);
    set('P', `δP=${del.P.toFixed(1)}`);
    set('H', `δH=${del.H.toFixed(1)}`);
  } else {
    set('D','δD='); set('P','δP='); set('H','δH=');
  }
  // 👇 Affiche Vmix (cm³/mol)
  if (Number.isFinite(Vmix)) {
    set('V', `Vmix=${Vmix.toFixed(1)} cm³/mol`);
  } else {
    set('V', 'Vmix=');
  }

}

  _computeVolume(mix) {
  if (!mix.rows.length) return null;
  const solvs = this.dataMgr.getSolvents();
  let sumW = 0, Vsum = 0;
  for (const r of mix.rows) {
    const s = solvs[r.solvIndex]; if (!s) continue;
    const w = Math.max(0, r.percent || 0);
    if (Number.isFinite(s.V)) Vsum += s.V * w;
    sumW += w;
  }
  if (sumW <= 0) return null;
  return Vsum / sumW; // cm³/mol
}

  _update3D(mix) {
    const teas = this._computeTeas(mix);
    if (!teas) { this._renderSummary(mix); return; }
    this.onMixChanged && this.onMixChanged(mix, teas);
    this._renderSummary(mix);
  }

  // Proxy pour App
  set onMixChanged(cb) { this._onMixChanged = cb; }
  get onMixChanged() { return this._onMixChanged; }
}


/* ============================================================================
 * 9) APP — Orchestration et glue UI/renderer
 * ========================================================================== */
class App {
  constructor() {
    this.data = new DataManager();
    this.sel = new SelectionManager();
    this.renderer = null;
    this.legend = null;
    this.mixMgr = new MixManager();
    this.mixUI = null;
  }

  async start() {
    await this.data.load();

    this.renderer = new TeasRenderer3D(this.sel, this.data);
    this.legend = new LegendManager(this.sel, this.data);

    this._uiControls();
    this._bindButtons();

    // Démarrage avec 1 solvant + 1 polymère
    this._addSolventSelector();
    this._addPolymerSelector();

    // Clic sur le triangle => colonne de droite
    this.renderer.onPick = (id, teas) => this._onPickPoint(id, teas);

    // Mix UI : callbacks branchés vers le renderer
this.mixUI = new MixUIManager(this.mixMgr, this.data, {
  onMixChanged: (mix, teas) => {
    // passe le nom courant pour que le label 3D l’utilise
    this.renderer.upsertMixPoint(mix.id, teas, { linked: mix.linked, name: mix.name });
    this.renderer.updateLinkedLines();
  },
  onMixRemoved: (mix) => {
    this.renderer.removeMixPoint(mix.id);
    this.renderer.updateLinkedLines();
  },
  onLinkToggled: (mix) => {
    this.renderer.setMixLinked(mix.id, mix.linked);
    this.renderer.updateLinkedLines();
  },
  onMixRenamed: (mix, newName) => {
    // met à jour le label 3D immédiatement
    this.renderer.renameMix(mix.id, newName);
  }
});

  }

  /* ---------- Colonne de droite : ajout d’un “Point #id” ---------- */
_onPickPoint(id, teas) {
  document.body.classList.add('has-picks');
  this.renderer._resize();

  const holder = document.getElementById('pickedColumn');

  const card = document.createElement('div');
  card.className = 'pick-card';
  card.dataset.pickId = String(id);

  // En-tête : titre (cliquable pour renommer) + bouton fermer
  const head = document.createElement('div');
  head.className = 'pick-head';

  const title = document.createElement('h4');
  title.className = "editable-title";
  title.textContent = `Point #${id}`;
  title.style.cursor = 'text';
  title.title = 'Cliquer pour renommer';

  // ——— Renommage inline (contentEditable) ———
  const enableEdit = () => {
    title.contentEditable = 'true';
    // place le caret à la fin
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(title);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    title.focus();
  };
const commitEdit = () => {
  title.contentEditable = 'false';
  let newName = (title.textContent || '').trim() || `Point #${id}`;
  if (newName.length > 12) newName = newName.slice(0, 12); 
  title.textContent = newName;
  this.renderer.renamePick(id, newName);
};
  // clic pour éditer
  title.addEventListener('click', () => enableEdit());
  // Enter valide, Escape annule
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); title.blur(); }
  });
  title.addEventListener('blur', commitEdit);

  const close = document.createElement('button');
  close.className = 'pick-close';
  close.type = 'button';
  close.title = 'Supprimer ce point';
  close.textContent = '×';
  close.addEventListener('click', () => {
    this.renderer.removePick(id);
    card.remove();
    if (!holder.querySelector('.pick-card')) {
      document.body.classList.remove('has-picks');
      this.renderer._resize();
    }
  });

  head.appendChild(title);
  head.appendChild(close);
  card.appendChild(head);

  // (plus d’input pour le nom ici)

  // TEAS
  const rowTEAS = document.createElement('div');
  rowTEAS.className = 'row';
  rowTEAS.innerHTML = `
    <div>fd=${teas.fd.toFixed(1)}</div>
    <div>fp=${teas.fp.toFixed(1)}</div>
    <div>fh=${teas.fh.toFixed(1)}</div>`;
  card.appendChild(rowTEAS);

  // δD/δP/δH
  const del = this.data.teasToDelta(teas.fd, teas.fp, teas.fh);
  const rowDELTA = document.createElement('div');
  rowDELTA.className = 'row';
  rowDELTA.innerHTML = `
    <div>δD=${del.D.toFixed(1)}</div>
    <div>δP=${del.P.toFixed(1)}</div>
    <div>δH=${del.H.toFixed(1)}</div>`;
  card.appendChild(rowDELTA);

  // Suggestions
  const sugg = document.createElement('div');
  sugg.className = 'pick-suggest';
  sugg.innerHTML = `<h5>Solvants proches</h5>`;
  const top = this.data.findNearestByTeas(teas, 5);
  top.forEach((o, i) => {
    const it = document.createElement('div');
    it.className = 'item';
    it.innerHTML = `
      <strong>${i+1}. ${o.name}</strong><br>
      <small>fd=${o.fd.toFixed(1)} • fp=${o.fp.toFixed(1)} • fh=${o.fh.toFixed(1)} — Δ=${o.dist.toFixed(1)}</small>`;
    // On peut, si tu veux, recopier le nom sur le titre :
    it.addEventListener('click', ()=> {
      title.textContent = o.name;
      this.renderer.renamePick(id, o.name);
    });
    sugg.appendChild(it);
  });
  card.appendChild(sugg);

  holder.prepend(card);
}


  /* ---------- Boutons colonne gauche ---------- */
  _bindButtons() {
    const addSolv = document.getElementById('addSolvent');
    const addPoly = document.getElementById('addPoly');
    const addMix  = document.getElementById('addMix');
    if (addSolv) addSolv.addEventListener('click', ()=> this._addSolventSelector());
    if (addPoly) addPoly.addEventListener('click', ()=> this._addPolymerSelector());
    if (addMix)  addMix.addEventListener('click', ()=> this.mixUI.createMixUI());
  }

  /* ---------- Barre labels/zoom (dans #labelsUI) ---------- */
  _uiControls() {
    const ui = document.getElementById('labelsUI');

    // Toggle labels solvants
    const btn = document.createElement('button'); btn.className='btn';
    const updateText = ()=> btn.textContent = `Noms des solvants : ${this.renderer.showSolventLabels ? 'Masquer' : 'Afficher'}`;
    updateText();
    btn.addEventListener('click', ()=>{ this.renderer.toggleSolventLabels(); updateText(); });
    ui.appendChild(btn);

    // Zone Zoom (label + slider)
    const wrap = document.createElement('div');
    wrap.className = 'zoom-control';

    const lab = document.createElement('span');
    lab.textContent = 'Zoom';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.style.width = '120px';

    // Valeur initiale alignée sur la caméra
    const initT = (CONFIG.CAMERA.INITIAL_Z - CONFIG.CAMERA.Z_MIN) / (CONFIG.CAMERA.Z_MAX - CONFIG.CAMERA.Z_MIN);
    slider.value = String(Math.round(initT * 100));

    // slider -> zoom
    slider.addEventListener('input', () => {
      const t = parseFloat(slider.value) / 100;
      this.renderer.setZoomNormalized(t);
    });

    // zoom (molette, code) -> slider
    this.renderer.onZoomChange = (t) => {
      slider.value = String(Math.round(t * 100));
    };

    wrap.appendChild(lab);
    wrap.appendChild(slider);
    ui.appendChild(wrap);
  }

  /* ---------- Ajout de sélecteurs ---------- */
  _addSolventSelector() {
    const block = document.getElementById('solventBlock');
    UIBuilder.createSelector(
      block, this.data.getSolvents(), CONFIG.COLORS.SOLVENTS,
      (index, color, selectEl)=>{ this.sel.addSolvent(index, color, selectEl); this._refresh(); },
      {
        linkable:true,
        removable:true,
        onLinkToggle: (checked, selectEl)=>{ this.sel.setSolventLinked(selectEl, checked); this._refresh(true); },
        onRemove: (selectEl, wrap)=>{ this.sel.removeSolventBySelect(selectEl); wrap.remove(); this._refresh(true); }
      }
    );
    this._refresh(true);
  }

  _addPolymerSelector() {
    const block = document.getElementById('polyBlock');
UIBuilder.createSelector(
  block,
  this.data.getPolymers(),
  CONFIG.COLORS.POLYMERS,
  (index, color, selectEl) => { this.sel.addPolymer(index, color, selectEl); this._refresh(); },
  {
    kind: 'polymer',                    // 👈 nouveau
    removable: true,
    onRemove: (selectEl, wrap) => { this.sel.removePolymerBySelect(selectEl); wrap.remove(); this._refresh(); }
  }
);

    this._refresh();
  }

  _refresh(updateLinks=false) {
    this.legend.refresh();
    this.renderer.refresh();
    if (updateLinks) this.renderer.updateLinkedLines();
  }
}


/* ============================================================================
 * 10) BOOT — Lancement de l’app
 * ========================================================================== */
window.addEventListener('DOMContentLoaded', async ()=>{
  try {
    const app = new App();
    await app.start();
  } catch (e) {
    console.error(e);
    alert('Erreur d’initialisation. Ouvre via un serveur local et vérifie les fichiers.');
  }
});
