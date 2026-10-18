/* =====================================================================
   NOTICIAS_PTY — Worker de noticias (Cloudflare Workers)
   ---------------------------------------------------------------------
   Lee los feeds RSS de medios panameños e internacionales, los convierte
   al formato de la app, los clasifica en las 8 categorías y los guarda
   en caché 10 minutos. No necesita KV, cron ni variables: se pega en el
   editor de Cloudflare y se despliega.

   Rutas:
     /            → lista de noticias (JSON) — la que usa la app
     /noticias    → igual que /
     /estado      → qué fuentes funcionaron, cuántas noticias trajo cada una
     ?refrescar=1 → ignora la caché y vuelve a leer los feeds

   Derechos de autor: solo se usa el titular, el extracto corto que el
   propio medio publica en su RSS (<description>) y el enlace a la nota
   original. Nunca el texto completo (<content:encoded>).
   ===================================================================== */

const VERSION = '1.2';
const MINUTOS_CACHE = 10;             // cada cuánto se vuelven a leer los feeds
const HORAS_RESPALDO = 48;            // copia de respaldo si todos los feeds fallan
const MAX_POR_FUENTE = 30;
const MAX_TOTAL = 160;
const MAX_INTERNACIONAL = 30;         // para que lo internacional no tape lo nacional
const DIAS_MAXIMOS = 4;               // descarta noticias más viejas que esto
const MS_TIMEOUT = 8000;
const LARGO_RESUMEN = 220;

// ---------------------------------------------------------------------
// FUENTES
// Para agregar o quitar un medio, edita solo esta lista.
//   origen:    'nacional' o 'internacional'
//   categoria: categoría fija (opcional; si no, se clasifica sola)
//   sitio:     dominio del medio (para arreglar imágenes rotas)
//   activo:    false para apagarla sin borrarla
// ---------------------------------------------------------------------
const FUENTES = [
  // Verificadas el 18-oct-2026
  { id: 'tvn',      nombre: 'TVN',              url: 'https://www.tvn-2.com/rss/',                          origen: 'nacional', sitio: 'https://www.tvn-2.com',            activo: true },
  { id: 'pa',       nombre: 'Panamá América',   url: 'https://www.panamaamerica.com.pa/rss/recent/index.xml', origen: 'nacional', sitio: 'https://www.panamaamerica.com.pa', activo: true },
  { id: 'p24',      nombre: 'Panamá 24 Horas',  url: 'https://www.panama24horas.com.pa/panama/feed/',       origen: 'nacional', sitio: 'https://www.panama24horas.com.pa', activo: true },

  // Por confirmar con /estado después de desplegar
  { id: 'acp',      nombre: 'Canal de Panamá',  url: 'https://pancanal.com/es/feed/',                       origen: 'nacional', categoria: 'la-ola', sitio: 'https://pancanal.com', activo: false }, // 404 el 18-oct-2026
  { id: 'bbc',      nombre: 'BBC Mundo',        url: 'https://feeds.bbci.co.uk/mundo/rss.xml',              origen: 'internacional', sitio: 'https://www.bbc.com',       activo: true },
  { id: 'f24',      nombre: 'France 24',        url: 'https://www.france24.com/es/rss',                     origen: 'internacional', sitio: 'https://www.france24.com',  activo: true }
];

// ---------------------------------------------------------------------
// CLASIFICACIÓN
// ---------------------------------------------------------------------

// Secciones de los medios (de la URL o de <category>) → categoría de la app.
// fija: true = se respeta siempre; false = solo es una pista.
const SECCIONES = {
  'tvmax': { cat: 'la-birria', fija: true },
  'deportes': { cat: 'la-birria', fija: true },
  'deporte': { cat: 'la-birria', fija: true },
  'futbol': { cat: 'la-birria', fija: true },
  'beisbol': { cat: 'la-birria', fija: true },
  'lpf': { cat: 'la-birria', fija: true },
  'entretenimiento': { cat: 'la-chacara', fija: true },
  'espectaculos': { cat: 'la-chacara', fija: true },
  'variedades': { cat: 'la-chacara', fija: true },
  'cultura': { cat: 'la-chacara', fija: true },
  'farandula': { cat: 'la-chacara', fija: true },
  'cine-y-tv': { cat: 'la-chacara', fija: true },
  'economia': { cat: 'la-ola', fija: true },
  'negocios': { cat: 'la-ola', fija: true },
  'finanzas': { cat: 'la-ola', fija: true },
  'lideres-360': { cat: 'la-ola', fija: false },
  'tecnologia': { cat: 'tecnologia', fija: true },
  'ciencia': { cat: 'tecnologia', fija: true },
  'politica': { cat: 'el-patio', fija: true },
  'judicial': { cat: 'el-patio', fija: true },
  'gobierno': { cat: 'el-patio', fija: false },
  'provincias': { cat: 'en-la-calle', fija: false },
  'comunidad': { cat: 'en-la-calle', fija: false },
  'mundo': { cat: 'INTERNACIONAL', fija: true },
  'internacional': { cat: 'INTERNACIONAL', fija: true },
  'internacionales': { cat: 'INTERNACIONAL', fija: true }
};

// Palabras clave (sin tildes, en minúsculas). Se cuentan coincidencias;
// el título vale doble. Gana la categoría con más puntos.
const PALABRAS = {
  'la-birria': ['lpf', 'futbol', 'beisbol', 'softbol', 'baloncesto', 'seleccion de panama', 'la sele', 'copa del mundo',
    'copa mundial', 'eliminatorias', 'gol', 'goles', 'liga', 'mlb', 'nba', 'nfl', 'boxeo', 'boxeador', 'atletismo',
    'olimpico', 'olimpicos', 'torneo', 'campeonato', 'jonron', 'pelotero', 'legionario', 'legionarios', 'estadio'],
  'tecnologia': ['tecnologia', 'tecnologica', 'tecnologico', 'inteligencia artificial', 'ia', 'ciberseguridad', 'ciberataque',
    'hackeo', 'hackers', 'internet', 'app', 'aplicacion movil', 'redes sociales', 'google', 'apple', 'microsoft',
    'openai', 'tiktok', 'whatsapp', 'smartphone', 'celulares', '5g', 'satelite', 'nasa', 'cohete', 'astronomos',
    'robot', 'robots', 'chip', 'chips', 'startup', 'criptomoneda', 'bitcoin'],
  'la-ola': ['canal de panama', 'acp', 'economia', 'economico', 'economica', 'banco', 'bancos', 'bancaria', 'empleo',
    'desempleo', 'inflacion', 'mef', 'exportaciones', 'importaciones', 'inversion extranjera', 'inversion privada', 'inversionistas', 'finanzas', 'impuesto',
    'impuestos', 'dgi', 'pib', 'bolsa de valores', 'comercio', 'zona libre', 'puerto', 'puertos', 'buques', 'transitos',
    'aranceles', 'presupuesto', 'deuda publica', 'combustible', 'gasolina', 'precios', 'acodeco', 'salario minimo'],
  'la-chacara': ['festival', 'concierto', 'carnaval', 'carnavales', 'folclor', 'folclore', 'folclorico', 'cultura',
    'cultural', 'cine', 'pelicula', 'musica', 'musical', 'artista', 'artistas', 'cantante', 'feria', 'teatro',
    'exposicion', 'museo', 'casco viejo', 'pollera', 'premios', 'grammy', 'farandula', 'celebridad', 'netflix',
    'libro', 'escritor', 'actor', 'actriz'],
  'en-la-calle': ['trafico', 'tranque', 'tranques', 'via espana', 'corredor', 'autopista', 'carretera', 'carreteras',
    'puente de las americas', 'puente centenario', 'metro de panama', 'metrobus', 'attt', 'accidente', 'choque',
    'cierre de via', 'sinaproc', 'inundacion', 'inundaciones', 'lluvias', 'deslizamiento', 'sismo', 'temblor',
    'incendio', 'bomberos', 'comunidad', 'comunidades', 'corregimiento', 'agua potable', 'idaan', 'apagon', 'basura',
    'chorrera', 'colon', 'chiriqui', 'veraguas', 'herrera', 'los santos', 'cocle', 'darien', 'bocas del toro',
    'arraijan', 'san miguelito', 'azuero'],
  'el-patio': ['asamblea', 'diputado', 'diputados', 'gobierno', 'presidente', 'mulino', 'ministro', 'ministra',
    'ministerio', 'contraloria', 'corte suprema', 'fiscal', 'fiscalia', 'ministerio publico', 'judicial', 'tribunal',
    'juez', 'juicio', 'ley', 'proyecto de ley', 'reforma', 'alcalde', 'alcaldia', 'partido', 'elecciones',
    'tribunal electoral', 'politica', 'policia', 'detenidos', 'aprehendido', 'homicidio', 'css', 'caja de seguro social',
    'meduca', 'minsa', 'protesta', 'huelga', 'sindicato']
};

// Para noticias internacionales: ¿es de la región?
const VECINOS = ['colombia', 'colombiano', 'colombiana', 'venezuela', 'venezolano', 'venezolana', 'costa rica',
  'costarricense', 'nicaragua', 'nicaraguense', 'honduras', 'hondureno', 'hondurena', 'el salvador', 'salvadoreno',
  'guatemala', 'guatemalteco', 'mexico', 'mexicano', 'mexicana', 'cuba', 'cubano', 'cubana', 'republica dominicana',
  'dominicano', 'haiti', 'puerto rico', 'ecuador', 'ecuatoriano', 'peru', 'peruano', 'bolivia', 'boliviano', 'chile',
  'chileno', 'argentina', 'argentino', 'uruguay', 'uruguayo', 'paraguay', 'paraguayo', 'brasil', 'brasileno',
  'brasilena', 'latinoamerica', 'america latina', 'centroamerica', 'caribe', 'sudamerica', 'panama'];

// Términos inequívocamente panameños: si una nota marcada como internacional
// los menciona en el título, se trata como nacional (los medios a veces la archivan mal).
const PANAMA = ['panama', 'panameno', 'panamena', 'panamenos', 'miviot', 'minsa', 'meduca', 'mulino', 'asamblea nacional',
  'sinaproc', 'idaan', 'attt', 'acp', 'css', 'contraloria', 'chiriqui', 'veraguas', 'herrera', 'los santos', 'cocle',
  'darien', 'bocas del toro', 'colon', 'chorrera', 'arraijan', 'san miguelito', 'azuero', 'imhpa', 'universidad de panama'];
const BUSCADOR_PANAMA = crearBuscador(PANAMA);

// Provincias y gentilicios: si aparecen en el TÍTULO, una nota "económica" débil
// (una sola palabra de La Ola) se va a En la calle — es noticia de la región.
const PROVINCIAS = ['chiriqui', 'chiricano', 'chiricana', 'chiricanos', 'veraguas', 'veraguense', 'veraguenses',
  'herrera', 'herrerano', 'herrerana', 'los santos', 'santeno', 'santena', 'santenos', 'cocle', 'coclesano', 'coclesana',
  'colon', 'colonense', 'colonenses', 'darien', 'darienita', 'bocas del toro', 'bocatoreno', 'bocatorena', 'chorrera',
  'chorrerano', 'arraijan', 'san miguelito', 'azuero', 'panama oeste', 'panama este', 'comarca', 'ngabe bugle',
  'guna yala', 'embera'];
const BUSCADOR_PROVINCIAS = crearBuscador(PROVINCIAS);
const MAX_OLA_DEBIL = 2;   // puntos de La Ola que todavía cuentan como "débil"

const PRIORIDAD = ['la-birria', 'tecnologia', 'la-ola', 'la-chacara', 'en-la-calle', 'el-patio'];

function normalizar(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function crearBuscador(lista) {
  const escapadas = lista.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:^|[^a-z0-9])(${escapadas.join('|')})(?=[^a-z0-9]|$)`, 'g');
}
const BUSCADORES = Object.fromEntries(Object.entries(PALABRAS).map(([c, l]) => [c, crearBuscador(l)]));
const BUSCADOR_VECINOS = crearBuscador(VECINOS);

function contar(regex, texto) {
  regex.lastIndex = 0;
  return (texto.match(regex) || []).length;
}

function seccionesDe(item) {
  const claves = [];
  try {
    new URL(item.link).pathname.split('/').filter(Boolean).slice(0, 3).forEach(s => claves.push(normalizar(s)));
  } catch {}
  item.categorias.slice(0, 3).forEach(c => claves.push(normalizar(c).trim().replace(/\s+/g, '-')));
  return claves.map(k => SECCIONES[k]).filter(Boolean);
}

function clasificar(item, fuente) {
  const titulo = normalizar(item.titulo);
  const cuerpo = normalizar(`${item.resumen} ${item.categorias.join(' ')}`);
  let origen = fuente.origen;

  const secciones = fuente.categoria ? [] : seccionesDe(item);
  if (secciones.some(s => s.cat === 'INTERNACIONAL') && contar(BUSCADOR_PANAMA, titulo) === 0) origen = 'internacional';

  if (fuente.categoria) return { categoria: fuente.categoria, origen };

  const fija = secciones.find(s => s.fija && s.cat !== 'INTERNACIONAL');
  if (fija) return { categoria: fija.cat, origen };

  const puntos = {};
  for (const cat of PRIORIDAD) {
    puntos[cat] = contar(BUSCADORES[cat], titulo) * 2 + contar(BUSCADORES[cat], cuerpo);
  }

  if (origen === 'internacional') {
    if (puntos['la-birria'] >= 2) return { categoria: 'la-birria', origen };
    if (puntos['tecnologia'] >= 2) return { categoria: 'tecnologia', origen };
    const regional = contar(BUSCADOR_VECINOS, titulo) * 2 + contar(BUSCADOR_VECINOS, cuerpo);
    return { categoria: regional > 0 ? 'vecinos' : 'mundo', origen };
  }

  const pista = secciones.find(s => !s.fija);
  if (pista) puntos[pista.cat] = (puntos[pista.cat] || 0) + 2;

  let mejor = null;
  for (const cat of PRIORIDAD) {
    if (puntos[cat] > 0 && (mejor === null || puntos[cat] > puntos[mejor])) mejor = cat;
  }
  if (mejor === 'la-ola' && puntos['la-ola'] <= MAX_OLA_DEBIL && contar(BUSCADOR_PROVINCIAS, titulo) > 0) {
    mejor = 'en-la-calle';
  }
  return { categoria: mejor || 'el-patio', origen };
}

// ---------------------------------------------------------------------
// LECTURA DE XML (RSS 2.0 y Atom) — sin librerías
// ---------------------------------------------------------------------
const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', iquest: '¿', iexcl: '¡', deg: '°',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü'
};

function decodificar(texto) {
  return String(texto || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENTIDADES[e] ?? m;
  });
}

function sinCdata(texto) {
  return String(texto || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// Texto plano a partir de HTML o texto con entidades
function textoPlano(texto) {
  let t = decodificar(sinCdata(texto));
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  t = decodificar(t);
  // Coletillas de WordPress y similares
  t = t.replace(/\s*La entrada .{0,300}? se public[oó] primero en .{0,120}?\.?\s*$/i, '')
       .replace(/\s*The post .{0,300}? appeared first on .{0,120}?\.?\s*$/i, '')
       .replace(/\s*(\[(…|\.\.\.)\]|Leer más|Seguir leyendo|Continue reading).*$/i, '');
  return t.replace(/\s+/g, ' ').trim();
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function etiqueta(bloque, nombre) {
  const m = bloque.match(new RegExp(`<${escaparRegex(nombre)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaparRegex(nombre)}>`, 'i'));
  return m ? m[1] : '';
}

function etiquetas(bloque, nombre) {
  const re = new RegExp(`<${escaparRegex(nombre)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaparRegex(nombre)}>`, 'gi');
  return [...bloque.matchAll(re)].map(m => m[1]);
}

function atributo(etiquetaCompleta, attr) {
  const m = etiquetaCompleta.match(new RegExp(`\\s${escaparRegex(attr)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodificar(m[2] ?? m[3] ?? '') : '';
}

function aperturas(bloque, nombre) {
  return [...bloque.matchAll(new RegExp(`<${escaparRegex(nombre)}\\b[^>]*>`, 'gi'))].map(m => m[0]);
}

function buscarImagen(bloque) {
  for (const t of aperturas(bloque, 'media:content')) {
    const tipo = atributo(t, 'type'), medio = atributo(t, 'medium');
    if (!tipo || tipo.startsWith('image') || medio === 'image') {
      const u = atributo(t, 'url');
      if (u) return u;
    }
  }
  for (const t of aperturas(bloque, 'media:thumbnail')) {
    const u = atributo(t, 'url');
    if (u) return u;
  }
  for (const t of aperturas(bloque, 'enclosure')) {
    if (atributo(t, 'type').startsWith('image')) {
      const u = atributo(t, 'url');
      if (u) return u;
    }
  }
  const html = decodificar(sinCdata(etiqueta(bloque, 'description') + etiqueta(bloque, 'content:encoded') + etiqueta(bloque, 'content')));
  const img = html.match(/<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  return img ? img[1] : '';
}

function enlaceAtom(bloque) {
  const enlaces = aperturas(bloque, 'link');
  const alterno = enlaces.find(l => !atributo(l, 'rel') || atributo(l, 'rel') === 'alternate');
  return alterno ? atributo(alterno, 'href') : '';
}

function leerFeed(xml) {
  const items = [];
  const esAtom = !/<item\b/i.test(xml) && /<entry\b/i.test(xml);
  const bloques = xml.match(esAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) || [];

  for (const b of bloques) {
    const link = esAtom ? enlaceAtom(b) : textoPlano(etiqueta(b, 'link')) || textoPlano(etiqueta(b, 'guid'));
    const resumenCrudo = esAtom ? (etiqueta(b, 'summary') || etiqueta(b, 'content')) : etiqueta(b, 'description');
    const categorias = [
      ...etiquetas(b, 'category').map(textoPlano),
      ...aperturas(b, 'category').map(t => atributo(t, 'term')).filter(Boolean),
      ...textoPlano(etiqueta(b, 'media:keywords')).split(',')
    ].map(s => s.trim()).filter(Boolean);

    items.push({
      titulo: textoPlano(etiqueta(b, 'title')),
      link,
      resumen: textoPlano(resumenCrudo),
      fechaCruda: textoPlano(etiqueta(b, 'pubDate') || etiqueta(b, 'published') || etiqueta(b, 'updated') || etiqueta(b, 'dc:date')),
      imagen: buscarImagen(b),
      categorias
    });
  }
  return items;
}

// ---------------------------------------------------------------------
// NORMALIZACIÓN
// ---------------------------------------------------------------------

// Fechas: RFC 822, ISO 8601, y el formato de Panamá América "Sat, 10/17/2026 - 18:15" (hora de Panamá)
function leerFecha(texto) {
  if (!texto) return null;
  const pa = texto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2}):(\d{2})/);
  if (pa) {
    const [, mes, dia, anio, h, min] = pa;
    const d = new Date(`${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:00-05:00`);
    return isNaN(d) ? null : d;
  }
  const d = new Date(texto);
  return isNaN(d) ? null : d;
}

function urlHttp(u, base) {
  try {
    const url = new URL(u, base);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url : null;
  } catch {
    return null;
  }
}

function arreglarImagen(u, fuente) {
  if (!u || !String(u).trim()) return '';
  const url = urlHttp(u, fuente.sitio);
  if (!url) return '';
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    const sitio = new URL(fuente.sitio);
    url.protocol = sitio.protocol;
    url.host = sitio.host;
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.href;
}

function limpiarEnlace(u, fuente) {
  if (!u || !String(u).trim()) return '';
  const url = urlHttp(u, fuente.sitio);
  if (!url) return '';
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(p => url.searchParams.delete(p));
  return url.href;
}

function recortar(texto, max) {
  if (texto.length <= max) return texto;
  const corte = texto.slice(0, max);
  const espacio = corte.lastIndexOf(' ');
  return `${corte.slice(0, espacio > max * 0.6 ? espacio : max).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

// ID estable a partir del enlace (FNV-1a 32 bits)
function hashId(texto) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Extractos que no describen la nota: promos de transmisión que algunos medios
// (p. ej. TVN/TVMAX) pegan igual en varias notas distintas.
const PROMO = /^(sintoniza|mira|sigue|disfruta|no te pierdas|vive)\b.{0,200}\b(en vivo|youtube|transmisi[oó]n|por el canal|por tvmax|por tvn)/i;

function normalizarItem(item, fuente, ahora, repetidos) {
  const urlFuente = limpiarEnlace(item.link, fuente);
  if (!item.titulo || !urlFuente) return null;

  const fecha = leerFecha(item.fechaCruda) || ahora;
  if (fecha > new Date(ahora.getTime() + 60 * 60 * 1000)) return null;               // fechas futuras raras
  if (ahora - fecha > DIAS_MAXIMOS * 24 * 60 * 60 * 1000) return null;               // muy vieja

  let resumen = item.resumen;
  if (normalizar(resumen) === normalizar(item.titulo)) resumen = '';
  if (PROMO.test(resumen) || repetidos.has(normalizar(resumen))) resumen = '';
  const { categoria, origen } = clasificar(item, fuente);

  return {
    id: hashId(urlFuente),
    titulo: item.titulo,
    categoria,
    origen,
    resumen: recortar(resumen, LARGO_RESUMEN),
    fecha: fecha.toISOString(),
    imagen: arreglarImagen(item.imagen, fuente),
    urlFuente,
    fuente: fuente.nombre
  };
}

// ---------------------------------------------------------------------
// DESCARGA
// ---------------------------------------------------------------------
async function decodificarRespuesta(resp) {
  const buffer = await resp.arrayBuffer();
  const cabecera = new TextDecoder('utf-8').decode(buffer.slice(0, 200));
  const declarada = (cabecera.match(/encoding=["']([\w-]+)["']/i) || [])[1]
    || ((resp.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1]
    || 'utf-8';
  try {
    return new TextDecoder(declarada.toLowerCase()).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function leerFuente(fuente, ahora) {
  const inicio = Date.now();
  try {
    const resp = await fetch(fuente.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NoticiasPty/1.0; lector RSS)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
      },
      signal: AbortSignal.timeout(MS_TIMEOUT),
      cf: { cacheTtl: 300 }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await decodificarRespuesta(resp);
    const crudos = leerFeed(xml);
    if (!crudos.length) throw new Error('El feed no trajo noticias (¿no es RSS?)');
    // Un mismo extracto en dos o más notas distintas es plantilla, no resumen
    const veces = {};
    crudos.forEach(i => { const r = normalizar(i.resumen); if (r) veces[r] = (veces[r] || 0) + 1; });
    const repetidos = new Set(Object.keys(veces).filter(r => veces[r] > 1));
    const items = crudos.map(i => normalizarItem(i, fuente, ahora, repetidos)).filter(Boolean)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .slice(0, MAX_POR_FUENTE);
    return { estado: { id: fuente.id, nombre: fuente.nombre, ok: true, enFeed: crudos.length, usadas: items.length, ms: Date.now() - inicio }, items };
  } catch (e) {
    return { estado: { id: fuente.id, nombre: fuente.nombre, ok: false, error: String(e && e.message || e), ms: Date.now() - inicio }, items: [] };
  }
}

async function construir() {
  const ahora = new Date();
  const resultados = await Promise.all(FUENTES.filter(f => f.activo).map(f => leerFuente(f, ahora)));

  const vistos = new Set();
  const noticias = [];
  let internacionales = 0;
  for (const n of resultados.flatMap(r => r.items).sort((a, b) => b.fecha.localeCompare(a.fecha))) {
    const clave = normalizar(n.titulo).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
    if (vistos.has(clave) || vistos.has(n.id)) continue;
    if (n.origen === 'internacional' && internacionales >= MAX_INTERNACIONAL) continue;
    if (n.origen === 'internacional') internacionales++;
    vistos.add(clave);
    vistos.add(n.id);
    noticias.push(n);
    if (noticias.length >= MAX_TOTAL) break;
  }

  const porCategoria = {};
  noticias.forEach(n => { porCategoria[n.categoria] = (porCategoria[n.categoria] || 0) + 1; });

  return {
    noticias,
    estado: {
      version: VERSION,
      generado: ahora.toISOString(),
      total: noticias.length,
      porCategoria,
      fuentes: resultados.map(r => r.estado)
    }
  };
}

// ---------------------------------------------------------------------
// CACHÉ Y RESPUESTAS
// ---------------------------------------------------------------------
const CLAVE = (nombre) => new Request(`https://noticias-pty.cache/${VERSION}/${nombre}`);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(datos, { status = 200, maxAge = 300, extra = {} } = {}) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
      ...CORS,
      ...extra
    }
  });
}

function paraCache(datos, segundos) {
  return new Response(JSON.stringify(datos), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${segundos}` }
  });
}

async function obtener(ctx, forzar) {
  const cache = caches.default;
  if (!forzar) {
    const [n, e] = await Promise.all([cache.match(CLAVE('noticias')), cache.match(CLAVE('estado'))]);
    if (n && e) return { noticias: await n.json(), estado: await e.json(), desdeCache: true };
  }

  const { noticias, estado } = await construir();

  if (noticias.length) {
    ctx.waitUntil(Promise.all([
      cache.put(CLAVE('noticias'), paraCache(noticias, MINUTOS_CACHE * 60)),
      cache.put(CLAVE('estado'), paraCache(estado, MINUTOS_CACHE * 60)),
      cache.put(CLAVE('respaldo'), paraCache(noticias, HORAS_RESPALDO * 3600))
    ]));
    return { noticias, estado, desdeCache: false };
  }

  // Todo falló: usar la última copia buena
  const respaldo = await cache.match(CLAVE('respaldo'));
  if (respaldo) return { noticias: await respaldo.json(), estado: { ...estado, usandoRespaldo: true }, desdeCache: true };
  return { noticias: [], estado, desdeCache: false };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json({ error: 'Método no permitido' }, { status: 405, maxAge: 0 });

    const url = new URL(request.url);
    const ruta = url.pathname.replace(/\/+$/, '') || '/';
    const forzar = url.searchParams.has('refrescar');

    try {
      if (ruta === '/' || ruta === '/noticias') {
        const { noticias, estado, desdeCache } = await obtener(ctx, forzar);
        if (!noticias.length) return json({ error: 'No se pudo leer ninguna fuente', estado }, { status: 502, maxAge: 0 });
        return json(noticias, { extra: { 'X-Generado': estado.generado, 'X-Desde-Cache': String(desdeCache) } });
      }
      if (ruta === '/estado') {
        const { estado, desdeCache } = await obtener(ctx, forzar);
        return json({ ...estado, desdeCache }, { maxAge: 0 });
      }
      return json({ error: 'Ruta no encontrada', rutas: ['/', '/noticias', '/estado'] }, { status: 404, maxAge: 0 });
    } catch (e) {
      return json({ error: 'Error interno', detalle: String(e && e.message || e) }, { status: 500, maxAge: 0 });
    }
  }
};

