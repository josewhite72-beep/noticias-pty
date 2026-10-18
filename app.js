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

// Fuente de datos. En la Fase 2 se cambia por la URL del Worker de RSS.
const URL_NOTICIAS = 'noticias.json';

const CLAVE_FAVORITOS = 'noticias-pty-favoritos-v2';   // guarda objetos completos
const CLAVE_FAVORITOS_V1 = 'noticias-pty-favoritos';   // versión anterior (solo IDs)

// 2. SELECTORES DEL DOM
const contenedorNoticias = document.getElementById('contenedor-noticias');
const navFiltros = document.getElementById('filtros');
const flechaIzq = document.getElementById('flecha-izq');
const flechaDer = document.getElementById('flecha-der');
const fechaHoy = document.getElementById('fecha-hoy');
const avisoOffline = document.getElementById('aviso-offline');

// 3. ESTADO GLOBAL
let noticiasActuales = [];
let categoriaActiva = 'todas';
let favoritos = leerFavoritos();     // { [id]: noticia }
let idsPendientesV1 = leerIdsV1();   // IDs viejos a migrar cuando lleguen las noticias

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

// Solo acepta enlaces http(s); bloquea "javascript:", "data:", etc.
function urlSegura(url) {
  try {
    const u = new URL(url, location.href);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '';
  } catch {
    return '';
  }
}

function formatearFecha(iso) {
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const [y, m, d] = String(iso || '').split('-');
  if (!y || !m || !d) return '';
  return `${parseInt(d, 10)} ${meses[parseInt(m, 10) - 1]} ${y}`;
}

function mostrarFechaHoy() {
  const texto = new Date().toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long' });
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
    const noticia = noticiasActuales.find(n => String(n.id) === clave);
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

function mostrarNoticias(lista) {
  if (lista.length === 0) {
    const mensaje = categoriaActiva === 'favoritos'
      ? 'Aún no tienes favoritos. Toca la ☆ de una noticia para guardarla y leerla luego, incluso sin conexión.'
      : 'No hay noticias en esta sección por hoy.';
    contenedorNoticias.innerHTML = `<p class="sin-noticias">${mensaje}</p>`;
    return;
  }

  contenedorNoticias.innerHTML = lista.map(noticia => {
    const nombreCategoria = CATEGORIAS[noticia.categoria] || noticia.categoria || '';
    const fav = esFavorito(noticia.id);
    const url = urlSegura(noticia.urlFuente);
    return `
      <article class="tarjeta-noticia">
        ${htmlImagen(noticia)}
        <div class="noticia-cuerpo">
          <div class="noticia-header">
            <span class="etiqueta ${esc(noticia.categoria)}">${esc(nombreCategoria)}</span>
            <button class="btn-favorito ${fav ? 'activo' : ''}" data-id="${esc(noticia.id)}"
                    aria-label="${fav ? 'Quitar de favoritos' : 'Agregar a favoritos'}">${fav ? '★' : '☆'}</button>
          </div>
          <h3>${esc(noticia.titulo)}</h3>
          <p>${esc(noticia.resumen)}</p>
          <div class="noticia-pie">
            <span class="fecha">${esc(formatearFecha(noticia.fecha))}</span>
            ${url
              ? `<a class="btn-leer" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Leer más</a>`
              : `<span class="btn-leer deshabilitado" aria-disabled="true">Leer más</span>`}
          </div>
        </div>
      </article>`;
  }).join('');
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
  if (e.target.closest('[data-accion="reintentar"]')) {
    cargarNoticias();
  }
});

// 8. CARGA DE DATOS
async function cargarNoticias() {
  mostrarSkeleton();
  try {
    const respuesta = await fetch(URL_NOTICIAS, { cache: 'no-cache' });
    if (!respuesta.ok) throw new Error(`Error HTTP: ${respuesta.status}`);
    const datos = await respuesta.json();
    if (!Array.isArray(datos)) throw new Error('Formato inválido: se esperaba una lista');
    noticiasActuales = datos;
    migrarFavoritosV1();
    aplicarFiltro(categoriaActiva);
  } catch (error) {
    console.error('Error al cargar noticias:', error);
    // Sin noticias, pero con favoritos guardados: la vista Favoritos sigue funcionando
    if (categoriaActiva === 'favoritos') aplicarFiltro('favoritos');
    else mostrarError();
  }
}

// 9. FILTROS
function aplicarFiltro(categoria) {
  categoriaActiva = categoria;
  let lista;
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

// 11. AVISO SIN CONEXIÓN
function actualizarAvisoOffline() {
  avisoOffline.hidden = navigator.onLine;
}
window.addEventListener('online', () => {
  actualizarAvisoOffline();
  cargarNoticias(); // al volver la señal, traer lo más nuevo
});
window.addEventListener('offline', actualizarAvisoOffline);

// 12. SERVICE WORKER
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('[SW] Registrado:', reg.scope))
      .catch(err => console.log('[SW] Error al registrar:', err));
  });
}

// 13. INICIO
document.addEventListener('DOMContentLoaded', () => {
  mostrarFechaHoy();
  actualizarFlechas();
  actualizarAvisoOffline();
  cargarNoticias();
});
