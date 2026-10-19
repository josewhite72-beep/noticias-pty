/* ============================================
   NOTICIAS_PTY — PWA + Favoritos + Filtros
   ============================================ */

// 1. CONSTANTES
const CATEGORIAS = {
  'el-patio':     'El patio',
  'en-la-calle':  'En la calle',
  'la-ola':       'La Ola',
  'la-chacara':   'La Chácara',
  'la-birria':    'La Birria',
  'mundo':        'Mundo',
  'vecinos':      'Vecinos',
  'tecnologia':   'Tecnología'
};

// Fuente de datos: funciones de Vercel en /api (mismo dominio que la app).
// Si fallan, la app usa las noticias de ejemplo de noticias.json.
const URL_API = '/api/noticias';
const URL_EJEMPLO = 'noticias.json';
// Búsqueda en los medios (función de Vercel)
const URL_BUSCAR = '/api/buscar';

const CLAVE_FAVORITOS = 'noticias-pty-favoritos-v2';   // guarda objetos completos
const CLAVE_FAVORITOS_V1 = 'noticias-pty-favoritos';   // versión anterior (solo IDs)

// 2. SELECTORES DEL DOM
const contenedorNoticias = document.getElementById('contenedor-noticias');
const navFiltros = document.getElementById('filtros');
const flechaIzq = document.getElementById('flecha-izq');
const flechaDer = document.getElementById('flecha-der');
const fechaHoy = document.getElementById('fecha-hoy');
const avisoOffline = document.getElementById('aviso-offline');
const avisoEjemplo = document.getElementById('aviso-ejemplo');
const btnRefrescar = document.getElementById('btn-refrescar');
const btnLimpiarCache = document.getElementById('btn-limpiar-cache');
const btnBuscar = document.getElementById('btn-buscar');
const barraBusqueda = document.getElementById('barra-busqueda');
const campoBusqueda = document.getElementById('campo-busqueda');
const btnCerrarBusqueda = document.getElementById('btn-cerrar-busqueda');

// 3. ESTADO GLOBAL
let noticiasActuales = [];
let categoriaActiva = 'todas';
let favoritos = leerFavoritos();     // { [id]: noticia }
let idsPendientesV1 = leerIdsV1();   // IDs viejos a migrar cuando lleguen las noticias
let encontradas = [];                // noticias traídas por la búsqueda en los medios (se suman a su categoría)

// 4. UTILIDADES

// Escapa texto antes de meterlo en HTML (evita inyección desde feeds de terceros)
function esc(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Solo acepta enlaces absolutos http(s); bloquea "javascript:", "data:", "#", etc.
function urlSegura(url) {
  try {
    const u = new URL(String(url || ''));
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
  } catch {
    return '';
  }
}

// Acepta "2026-10-18" o "2026-10-18T10:52:43Z". Muestra tiempo relativo si es reciente.
function formatearFecha(iso) {
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const texto = String(iso || '');
  const soloDia = /^\d{4}-\d{2}-\d{2}$/.test(texto);
  const fecha = new Date(soloDia ? `${texto}T12:00:00` : texto);
  if (isNaN(fecha)) return '';

  if (!soloDia) {
    const minutos = Math.round((Date.now() - fecha) / 60000);
    if (minutos < 1) return 'ahora';
    if (minutos < 60) return `hace ${minutos} min`;
    const horas = Math.round(minutos / 60);
    if (horas < 24) return `hace ${horas} h`;
    if (horas < 48) return 'ayer';
  }
  const anio = fecha.getFullYear() !== new Date().getFullYear() ? ` ${fecha.getFullYear()}` : '';
  return `${fecha.getDate()} ${meses[fecha.getMonth()]}${anio}`;
}

// Minúsculas y sin tildes, para comparar textos
function normalizar(texto) {
  return String(texto ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function claveTitulo(noticia) {
  return normalizar(noticia.titulo).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
}

// Une listas sin repetir (por id o por título) y ordena de la más nueva a la más vieja
function combinar(...listas) {
  const ids = new Set();
  const titulos = new Set();
  const salida = [];
  for (const n of listas.flat()) {
    if (!n) continue;
    const id = String(n.id), t = claveTitulo(n);
    if (ids.has(id) || (t && titulos.has(t))) continue;
    ids.add(id);
    if (t) titulos.add(t);
    salida.push(n);
  }
  return salida.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
}

function mostrarFechaHoy() {
  const corta = window.innerWidth < 430;
  const texto = new Date().toLocaleDateString('es-PA', corta
    ? { weekday: 'short', day: 'numeric', month: 'short' }
    : { weekday: 'long', day: 'numeric', month: 'long' });
  fechaHoy.textContent = texto.charAt(0).toUpperCase() + texto.slice(1);
}

// 5. FAVORITOS (persistencia de objetos completos → funcionan offline y aunque la noticia salga del feed)
function leerFavoritos() {
  try {
    const datos = JSON.parse(localStorage.getItem(CLAVE_FAVORITOS));
    return (datos && typeof datos === 'object' && !Array.isArray(datos)) ? datos : {};
  } catch {
    return {};
  }
}

function leerIdsV1() {
  try {
    const ids = JSON.parse(localStorage.getItem(CLAVE_FAVORITOS_V1));
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

function guardarFavoritos() {
  try {
    localStorage.setItem(CLAVE_FAVORITOS, JSON.stringify(favoritos));
  } catch (e) {
    console.warn('No se pudieron guardar los favoritos:', e);
  }
}

// Convierte los favoritos viejos (solo IDs) al formato nuevo, una sola vez
function migrarFavoritosV1() {
  if (!idsPendientesV1.length) return;
  noticiasActuales.forEach(n => {
    if (idsPendientesV1.includes(String(n.id))) favoritos[String(n.id)] = n;
  });
  idsPendientesV1 = [];
  guardarFavoritos();
  try { localStorage.removeItem(CLAVE_FAVORITOS_V1); } catch {}
}

function esFavorito(id) {
  return Object.prototype.hasOwnProperty.call(favoritos, String(id));
}

function toggleFavorito(id) {
  const clave = String(id);
  if (esFavorito(clave)) {
    delete favoritos[clave];
  } else {
    const noticia = noticiasActuales.find(n => String(n.id) === clave)
      || busqueda.externos?.find(n => String(n.id) === clave);
    if (!noticia) return;
    favoritos[clave] = { ...noticia, guardadoEn: new Date().toISOString() };
  }
  guardarFavoritos();

  // En la vista Favoritos, volver a dibujar para que desaparezca la tarjeta quitada
  if (categoriaActiva === 'favoritos') {
    aplicarFiltro('favoritos');
    return;
  }

  const btn = contenedorNoticias.querySelector(`.btn-favorito[data-id="${CSS.escape(clave)}"]`);
  if (btn) {
    const activo = esFavorito(clave);
    btn.classList.toggle('activo', activo);
    btn.textContent = activo ? '★' : '☆';
    btn.setAttribute('aria-label', activo ? 'Quitar de favoritos' : 'Agregar a favoritos');
  }
}

// 6. SKELETON Y ERROR
function mostrarSkeleton() {
  contenedorNoticias.innerHTML = Array.from({ length: 3 }, () => `
    <div class="skeleton">
      <div class="skeleton-img"></div>
      <div class="skeleton-linea corta"></div>
      <div class="skeleton-linea larga"></div>
      <div class="skeleton-linea"></div>
    </div>`).join('');
}

function mostrarError() {
  contenedorNoticias.innerHTML = `
    <div class="estado-error">
      <p>⚠️ No se pudieron cargar las noticias.</p>
      <p>Verifica tu conexión o intenta de nuevo.</p>
      <button class="btn-reintentar" data-accion="reintentar">Reintentar</button>
    </div>`;
}

// 7. RENDERIZADOR
function htmlImagen(noticia) {
  const src = urlSegura(noticia.imagen);
  const cat = esc(noticia.categoria);
  // Sin imagen (o si falla al cargar): franja con el color de la categoría
  const placeholder = `<div class="noticia-img placeholder ${cat}" aria-hidden="true"></div>`;
  if (!src) return placeholder;
  return `<img src="${esc(src)}" alt="" class="noticia-img" loading="lazy" data-cat="${cat}">`;
}

function htmlTarjeta(noticia) {
  const nombreCategoria = CATEGORIAS[noticia.categoria] || noticia.categoria || '';
  const fav = esFavorito(noticia.id);
  const url = urlSegura(noticia.urlFuente);
  return `
    <article class="tarjeta-noticia" data-id="${esc(noticia.id)}">
      ${htmlImagen(noticia)}
      <div class="noticia-cuerpo">
        <div class="noticia-header">
          <div class="etiquetas">
            <button class="etiqueta ${esc(noticia.categoria)}" data-ir-categoria="${esc(noticia.categoria)}" data-id="${esc(noticia.id)}"
                    aria-label="Ver en ${esc(nombreCategoria)}">${esc(nombreCategoria)}</button>
            ${noticia.externa ? '<span class="pill-externa" title="Encontrada con el buscador">🔎 búsqueda</span>' : ''}
          </div>
          <button class="btn-favorito ${fav ? 'activo' : ''}" data-id="${esc(noticia.id)}"
                  aria-label="${fav ? 'Quitar de favoritos' : 'Agregar a favoritos'}">${fav ? '★' : '☆'}</button>
        </div>
        <h3>${esc(noticia.titulo)}</h3>
        ${noticia.resumen ? `<p>${esc(noticia.resumen)}</p>` : ''}
        <div class="noticia-pie">
          <span class="fecha">${[noticia.fuente, formatearFecha(noticia.fecha)].filter(Boolean).map(esc).join(' · ')}</span>
          ${url
            ? `<a class="btn-leer" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Leer más</a>`
            : `<span class="btn-leer deshabilitado" aria-disabled="true">Leer más</span>`}
        </div>
      </div>
    </article>`;
}

function mostrarNoticias(lista) {
  if (lista.length === 0) {
    const mensaje = categoriaActiva === 'favoritos'
      ? 'Aún no tienes favoritos. Toca la ☆ de una noticia para guardarla y leerla luego, incluso sin conexión.'
      : 'No hay noticias en esta sección por hoy.';
    contenedorNoticias.innerHTML = `<p class="sin-noticias">${mensaje}</p>`;
    return;
  }
  contenedorNoticias.innerHTML = lista.map(htmlTarjeta).join('');
}

// Si una imagen falla, se reemplaza por el bloque de categoría
contenedorNoticias.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('noticia-img')) return;
  const div = document.createElement('div');
  div.className = `noticia-img placeholder ${img.dataset.cat || ''}`;
  div.setAttribute('aria-hidden', 'true');
  img.replaceWith(div);
}, true); // "error" no burbujea; se captura

// Delegación de eventos: un solo listener para estrellas y "Reintentar"
contenedorNoticias.addEventListener('click', (e) => {
  const btnFav = e.target.closest('.btn-favorito');
  if (btnFav) {
    toggleFavorito(btnFav.dataset.id);
    return;
  }
  const etiqueta = e.target.closest('[data-ir-categoria]');
  if (etiqueta) {
    irANoticia(etiqueta.dataset.irCategoria, etiqueta.dataset.id);
    return;
  }
  if (e.target.closest('[data-accion="buscar-medios"]')) {
    buscarEnMedios();
    return;
  }
  if (e.target.closest('[data-accion="reintentar"]')) {
    cargarNoticias();
  }
});

// 8. CARGA DE DATOS
async function pedirLista(url) {
  const respuesta = await fetch(url, { cache: 'no-cache' });
  if (!respuesta.ok) throw new Error(`Error HTTP: ${respuesta.status}`);
  const datos = await respuesta.json();
  if (!Array.isArray(datos) || !datos.length) throw new Error('Respuesta vacía o con formato inválido');
  return datos;
}

let cargando = false;
async function cargarNoticias({ silencioso = false } = {}) {
  if (cargando) return;
  cargando = true;
  if (!silencioso || !noticiasActuales.length) mostrarSkeleton();
  btnRefrescar?.classList.add('girando');

  let datos = null;
  let deEjemplo = false;
  try {
    if (URL_API) {
      try {
        datos = await pedirLista(URL_API);
      } catch (e) {
        console.warn('No se pudo leer /api/noticias; uso las noticias de ejemplo.', e);
      }
    }
    if (!datos) {
      datos = await pedirLista(URL_EJEMPLO);
      deEjemplo = true;
    }
    noticiasActuales = combinar(datos, encontradas);
    avisoEjemplo.hidden = !deEjemplo;
    migrarFavoritosV1();
    aplicarFiltro(categoriaActiva);
  } catch (error) {
    console.error('Error al cargar noticias:', error);
    // Sin noticias, pero con favoritos guardados: la vista Favoritos sigue funcionando
    if (categoriaActiva === 'favoritos') aplicarFiltro('favoritos');
    else if (!noticiasActuales.length) mostrarError();
  } finally {
    cargando = false;
    btnRefrescar?.classList.remove('girando');
  }
}

btnRefrescar?.addEventListener('click', () => cargarNoticias());

// Al volver a la app después de un rato, traer lo nuevo sin borrar la pantalla
let ultimaVisita = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    ultimaVisita = Date.now();
  } else if (Date.now() - ultimaVisita > 10 * 60 * 1000) {
    cargarNoticias({ silencioso: true });
  }
});

// 9. FILTROS
function aplicarFiltro(categoria) {
  categoriaActiva = categoria;
  let lista;
  if (categoria === 'busqueda') {
    mostrarBusqueda();
    return;
  }
  if (categoria === 'todas') {
    lista = noticiasActuales;
  } else if (categoria === 'favoritos') {
    // Más recientes primero
    lista = Object.values(favoritos).sort((a, b) =>
      String(b.guardadoEn || '').localeCompare(String(a.guardadoEn || '')));
  } else {
    lista = noticiasActuales.filter(n => n.categoria === categoria);
  }
  mostrarNoticias(lista);
}

navFiltros.addEventListener('click', (e) => {
  const boton = e.target.closest('.btn-filtro');
  if (!boton) return;
  if (!barraBusqueda.hidden) cerrarBusqueda({ restaurar: false });
  navFiltros.querySelector('.btn-filtro.activo')?.classList.remove('activo');
  boton.classList.add('activo');
  boton.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  aplicarFiltro(boton.dataset.categoria);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// 10. FLECHAS DE LA FILA DE FILTROS
function actualizarFlechas() {
  const { scrollLeft, scrollWidth, clientWidth } = navFiltros;
  const hayMasIzq = scrollLeft > 4;
  const hayMasDer = scrollLeft + clientWidth < scrollWidth - 4;
  flechaIzq.hidden = !hayMasIzq;
  flechaDer.hidden = !hayMasDer;
  navFiltros.classList.toggle('fade-izq', hayMasIzq);
  navFiltros.classList.toggle('fade-der', hayMasDer);
}

function desplazarFiltros(direccion) {
  navFiltros.scrollBy({ left: direccion * navFiltros.clientWidth * 0.7, behavior: 'smooth' });
}

flechaIzq.addEventListener('click', () => desplazarFiltros(-1));
flechaDer.addEventListener('click', () => desplazarFiltros(1));
navFiltros.addEventListener('scroll', actualizarFlechas, { passive: true });
window.addEventListener('resize', actualizarFlechas);

// 10b. BUSCADOR
// Nivel 1: filtra al instante las noticias que ya están en la app (y los favoritos).
// Nivel 2: al pulsar Buscar (Enter) consulta /api/buscar, que busca en los
//          medios vía Google News y devuelve los resultados ya clasificados.
const busqueda = {
  texto: '',
  previa: 'todas',      // categoría a la que se vuelve al cerrar
  externos: null,       // null = aún no se ha buscado en los medios
  estado: 'inactivo',   // inactivo | buscando | listo | error
  error: '',
  control: null         // AbortController de la petición en curso
};

function marcarChip(categoria) {
  navFiltros.querySelector('.btn-filtro.activo')?.classList.remove('activo');
  const chip = navFiltros.querySelector(`.btn-filtro[data-categoria="${CSS.escape(categoria)}"]`);
  if (chip) {
    chip.classList.add('activo');
    chip.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }
}

function buscarLocal(texto) {
  const terminos = normalizar(texto).split(/\s+/).filter(Boolean);
  if (!terminos.length) return [];
  const todas = combinar(noticiasActuales, Object.values(favoritos));
  return todas.filter(n => {
    const pajar = normalizar(`${n.titulo} ${n.resumen} ${n.fuente} ${CATEGORIAS[n.categoria] || ''}`);
    return terminos.every(t => pajar.includes(t));
  });
}

function mostrarBusqueda() {
  const texto = busqueda.texto;
  if (texto.length < 2) {
    contenedorNoticias.innerHTML = `<p class="sin-noticias">Escribe al menos 2 letras. Busca en las noticias de la app;
      pulsa <strong>Buscar</strong> en el teclado para buscar también en los medios.</p>`;
    return;
  }

  // Lo que trajo esta búsqueda va en "En los medios", aunque ya se haya sumado a la app
  const idsExternos = new Set((busqueda.externos || []).map(n => String(n.id)));
  const locales = buscarLocal(texto).filter(n => !idsExternos.has(String(n.id)));
  const titulosLocales = new Set(locales.map(claveTitulo));
  const externos = (busqueda.externos || []).filter(n => !titulosLocales.has(claveTitulo(n)));

  const q = esc(texto);
  let html = `<h2 class="titulo-seccion">En la app <span>(${locales.length})</span></h2>`;
  html += locales.length
    ? locales.map(htmlTarjeta).join('')
    : `<p class="sin-noticias corto">No hay noticias con «${q}» en la app.</p>`;

  if (busqueda.estado === 'inactivo') {
    html += URL_BUSCAR
      ? `<button class="btn-buscar-medios" data-accion="buscar-medios">🔎 Buscar «${q}» en los medios</button>`
      : '';
  } else if (busqueda.estado === 'buscando') {
    html += `<p class="buscando"><span class="punto-carga"></span> Buscando «${q}» en los medios…</p>`;
  } else if (busqueda.estado === 'error') {
    html += `<div class="estado-error corto"><p>${esc(busqueda.error)}</p>
      <button class="btn-reintentar" data-accion="buscar-medios">Reintentar</button></div>`;
  } else {
    html += `<h2 class="titulo-seccion">En los medios <span>(${externos.length})</span></h2>`;
    html += externos.length
      ? externos.map(htmlTarjeta).join('') +
        `<p class="nota-busqueda">Toca la etiqueta de color para ver la noticia en su categoría.</p>`
      : `<p class="sin-noticias corto">${(busqueda.externos || []).length
          ? 'Lo que encontraron los medios ya está arriba.'
          : `Los medios no tienen nada sobre «${q}».`}</p>`;
  }
  contenedorNoticias.innerHTML = html;
}

async function buscarEnMedios() {
  const texto = busqueda.texto;
  if (texto.length < 2 || !URL_BUSCAR) return;
  if (!navigator.onLine) {
    busqueda.estado = 'error';
    busqueda.error = 'Sin conexión: solo se buscó en las noticias guardadas en la app.';
    mostrarBusqueda();
    return;
  }

  busqueda.control?.abort();
  const control = new AbortController();
  busqueda.control = control;
  busqueda.estado = 'buscando';
  mostrarBusqueda();

  try {
    const resp = await fetch(`${URL_BUSCAR}?q=${encodeURIComponent(texto)}`, { signal: control.signal });
    if (resp.status === 404) {
      const err = new Error('Ruta /buscar no existe');
      err.sinRuta = true;
      throw err;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const datos = await resp.json();
    if (control !== busqueda.control || texto !== busqueda.texto) return;   // el usuario ya cambió el texto
    const resultados = Array.isArray(datos.resultados) ? datos.resultados.filter(n => n && n.titulo && n.id) : [];
    busqueda.externos = resultados;
    busqueda.estado = 'listo';
    // Se suman a la app: aparecen también en su categoría hasta que cierres la app
    encontradas = combinar(encontradas, resultados).slice(0, 60);
    noticiasActuales = combinar(noticiasActuales, resultados);
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn('Búsqueda en los medios falló:', e);
    if (control !== busqueda.control) return;
    busqueda.estado = 'error';
    busqueda.error = e.sinRuta
      ? 'La búsqueda todavía no está publicada en Vercel. Espera a que termine el despliegue e intenta de nuevo.'
      : 'No se pudo buscar en los medios. Intenta de nuevo en un momento.';
  }
  if (categoriaActiva === 'busqueda') mostrarBusqueda();
}

function abrirBusqueda() {
  if (barraBusqueda.hidden) {
    busqueda.previa = categoriaActiva === 'busqueda' ? busqueda.previa : categoriaActiva;
    barraBusqueda.hidden = false;
    btnBuscar.setAttribute('aria-expanded', 'true');
    btnBuscar.classList.add('activo');
  }
  campoBusqueda.focus();
  campoBusqueda.select();
}

function cerrarBusqueda({ restaurar = true } = {}) {
  busqueda.control?.abort();
  busqueda.control = null;
  busqueda.texto = '';
  busqueda.externos = null;
  busqueda.estado = 'inactivo';
  campoBusqueda.value = '';
  campoBusqueda.blur();
  barraBusqueda.hidden = true;
  btnBuscar.setAttribute('aria-expanded', 'false');
  btnBuscar.classList.remove('activo');
  if (restaurar) {
    marcarChip(busqueda.previa);
    aplicarFiltro(busqueda.previa);
  }
}

// Lleva a la categoría de la noticia y la resalta
function irANoticia(categoria, id) {
  if (!CATEGORIAS[categoria]) return;
  if (!barraBusqueda.hidden) cerrarBusqueda({ restaurar: false });
  marcarChip(categoria);
  aplicarFiltro(categoria);
  const tarjeta = id && contenedorNoticias.querySelector(`.tarjeta-noticia[data-id="${CSS.escape(String(id))}"]`);
  if (tarjeta) {
    // Esperar a que el navegador pinte la lista antes de desplazarse
    requestAnimationFrame(() => {
      const alto = document.querySelector('.app-header')?.offsetHeight || 0;
      window.scrollTo({ top: tarjeta.getBoundingClientRect().top + window.scrollY - alto - 12, behavior: 'smooth' });
      tarjeta.classList.add('resaltada');
      setTimeout(() => tarjeta.classList.remove('resaltada'), 2200);
    });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

let temporizadorBusqueda = null;
campoBusqueda.addEventListener('input', () => {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(() => {
    const texto = campoBusqueda.value.replace(/\s+/g, ' ').trim();
    if (texto === busqueda.texto) return;
    busqueda.control?.abort();
    busqueda.texto = texto;
    busqueda.externos = null;
    busqueda.estado = 'inactivo';
    if (!texto) {
      // Campo vacío: volver a la categoría anterior sin cerrar la barra
      categoriaActiva = busqueda.previa;
      marcarChip(busqueda.previa);
      aplicarFiltro(busqueda.previa);
      return;
    }
    if (categoriaActiva !== 'busqueda') {
      navFiltros.querySelector('.btn-filtro.activo')?.classList.remove('activo');
      categoriaActiva = 'busqueda';
      window.scrollTo({ top: 0 });
    }
    mostrarBusqueda();
  }, 180);
});

// Enter / botón "Buscar" del teclado → buscar también en los medios
barraBusqueda.addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(temporizadorBusqueda);
  const texto = campoBusqueda.value.replace(/\s+/g, ' ').trim();
  if (texto.length < 2) return;
  if (texto !== busqueda.texto || categoriaActiva !== 'busqueda') {
    busqueda.texto = texto;
    busqueda.externos = null;
    if (categoriaActiva !== 'busqueda') {
      navFiltros.querySelector('.btn-filtro.activo')?.classList.remove('activo');
      categoriaActiva = 'busqueda';
    }
  }
  campoBusqueda.blur();   // esconde el teclado para ver los resultados
  buscarEnMedios();
});

campoBusqueda.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cerrarBusqueda();
});
btnBuscar.addEventListener('click', () => (barraBusqueda.hidden ? abrirBusqueda() : cerrarBusqueda()));
btnCerrarBusqueda.addEventListener('click', () => cerrarBusqueda());

// 11. AVISO SIN CONEXIÓN
function actualizarAvisoOffline() {
  avisoOffline.hidden = navigator.onLine;
}
window.addEventListener('online', () => {
  actualizarAvisoOffline();
  cargarNoticias({ silencioso: true }); // al volver la señal, traer lo más nuevo
});
window.addEventListener('offline', actualizarAvisoOffline);

// 12. LIMPIAR CACHÉ (fuerza la última versión de la app; no borra favoritos)
btnLimpiarCache?.addEventListener('click', async () => {
  if (!confirm('¿Actualizar la app? Se borrará la caché y se recargará. Tus favoritos se conservan.')) return;
  try {
    if ('caches' in window) {
      const nombres = await caches.keys();
      await Promise.all(nombres.map(n => caches.delete(n)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } finally {
    location.reload();
  }
});

// 13. SERVICE WORKER
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('[SW] Registrado:', reg.scope))
      .catch(err => console.log('[SW] Error al registrar:', err));
  });
}

// 14. INICIO
document.addEventListener('DOMContentLoaded', () => {
  mostrarFechaHoy();
  actualizarFlechas();
  actualizarAvisoOffline();
  cargarNoticias();
});
