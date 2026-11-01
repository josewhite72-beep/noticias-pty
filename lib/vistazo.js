/* =====================================================================
   NOTICIAS_PTY — Vistazo Geopolítico Hoy
   ---------------------------------------------------------------------
   Una vez al día toma los titulares geopolíticos (geo: true) de las
   últimas horas y le pide a Groq un resumen neutral de 5 puntos, cada
   uno con las noticias que lo respaldan.

   - La edición del día empieza a las 5:00 a. m. (hora de Panamá): antes
     de esa hora se sigue mostrando la del día anterior.
   - Solo se envían a la IA titulares y extractos del RSS (nunca artículos
     completos) y se le exige no agregar nada que no esté en la lista.
   - Necesita la variable de entorno GROQ_API_KEY en Vercel.
     Opcional: GROQ_MODEL para cambiar el modelo principal.
   ===================================================================== */

import { obtener } from './noticias.js';

const URL_GROQ = 'https://api.groq.com/openai/v1/chat/completions';
// llama-3.3-70b-versatile fue retirado por Groq el 16-ago-2026; estos son sus reemplazos
const MODELOS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const MS_TIMEOUT_IA = 25000;
const HORAS_VENTANA = 30;          // noticias de las últimas 30 h
const MAX_NOTICIAS = 24;           // cuántos titulares recibe la IA
const MAX_POR_MEDIO = 8;           // para que un solo medio no domine
const MIN_NOTICIAS = 4;            // con menos, no vale la pena resumir
const PUNTOS = 5;
const MINUTOS_ESPERA_ERROR = 5;    // tras un fallo, no reintentar enseguida

// Día de la edición (AAAA-MM-DD). Panamá es UTC-5 todo el año; la edición
// cambia a las 5:00 a. m. de Panamá = 10:00 UTC.
export function diaEdicion(fecha = new Date()) {
  return new Date(fecha.getTime() - 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
  'octubre', 'noviembre', 'diciembre'];
function fechaLarga(dia) {
  const d = new Date(`${dia}T12:00:00Z`);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

const INSTRUCCIONES = `Eres el editor de "Vistazo Geopolítico", un resumen diario para lectores en Panamá.
Recibirás una lista numerada de titulares y extractos de noticias de hoy, publicados por distintos medios.
Tu tarea: elegir los ${PUNTOS} temas geopolíticos más importantes del día y explicar cada uno con claridad.

Reglas estrictas:
1. Usa SOLO la información de la lista. No agregues datos, cifras, nombres, fechas ni antecedentes que no aparezcan en ella.
2. Tono neutral y descriptivo, como una agencia de noticias. Sin opiniones, sin adjetivos valorativos, sin predicciones.
3. Atribuye las afirmaciones polémicas a quien las hace ("según…", "X afirmó…"). Si los medios difieren, dilo.
4. Agrupa en un mismo punto las noticias que tratan del mismo tema.
5. Conserva los matices del original: si dice "posible", "presunto", "propuesta", "podría", "según", mantenlo. Nunca conviertas un anuncio, una propuesta o una aprobación preliminar en un hecho consumado.
6. En "fuentes" pon solo los números de las noticias que tratan exactamente ese tema. No agregues noticias de temas parecidos.
7. Si en la lista hay temas que afecten a Panamá, al Canal o a América Latina, dales prioridad.
8. Escribe en español claro y directo. No uses markdown.

Responde SOLO con JSON válido, con esta forma exacta:
{"puntos":[{"titulo":"máximo 10 palabras","texto":"2 o 3 oraciones, máximo 60 palabras","importancia":"una oración de máximo 30 palabras sobre por qué importa, sin especular más allá de la lista","fuentes":[números de la lista en que se basa el punto]}]}
Da exactamente ${PUNTOS} puntos si el material alcanza; si no, menos.`;

// ---------------------------------------------------------------------
// Selección de noticias
// ---------------------------------------------------------------------
function elegirNoticias(noticias, ahora) {
  const limite = ahora.getTime() - HORAS_VENTANA * 60 * 60 * 1000;
  const porMedio = {};
  const elegidas = [];
  const recientes = noticias
    .filter(n => n.geo && Date.parse(n.fecha) >= limite)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  for (const n of recientes) {
    const medio = n.fuente || '?';
    if ((porMedio[medio] || 0) >= MAX_POR_MEDIO) continue;
    porMedio[medio] = (porMedio[medio] || 0) + 1;
    elegidas.push(n);
    if (elegidas.length >= MAX_NOTICIAS) break;
  }
  return elegidas;
}

function listaParaIA(noticias) {
  return noticias.map((n, i) => {
    const extracto = n.resumen ? ` — ${n.resumen}` : '';
    return `[${i + 1}] ${n.fuente} · ${n.origen === 'nacional' ? 'Panamá' : 'internacional'} · ${n.titulo}${extracto}`;
  }).join('\n');
}

// ---------------------------------------------------------------------
// Llamada a Groq
// ---------------------------------------------------------------------
async function pedirGroq(clave, cuerpo) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), MS_TIMEOUT_IA);
  try {
    const resp = await fetch(URL_GROQ, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${clave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: control.signal
    });
    const texto = await resp.text();
    if (!resp.ok) {
      const err = new Error(`Groq HTTP ${resp.status}: ${texto.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    const datos = JSON.parse(texto);
    return String(datos?.choices?.[0]?.message?.content || '');
  } finally {
    clearTimeout(reloj);
  }
}

function leerJSON(texto) {
  try {
    return JSON.parse(texto);
  } catch {
    const m = String(texto).match(/\{[\s\S]*\}/);   // por si viene con texto alrededor
    if (m) return JSON.parse(m[0]);
    throw new Error('La IA no devolvió JSON');
  }
}

async function generarConIA(clave, mensajes) {
  const principal = (globalThis.process?.env?.GROQ_MODEL || '').trim();
  const modelos = [...new Set([principal, ...MODELOS].filter(Boolean))];
  let ultimoError = null;
  // Primero con modo JSON; si el modelo no lo acepta, sin él
  for (const conJSON of [true, false]) {
    for (const modelo of modelos) {
      try {
        const cuerpo = {
          model: modelo,
          messages: mensajes,
          temperature: 0.2,
          max_completion_tokens: 2500
        };
        if (conJSON) cuerpo.response_format = { type: 'json_object' };
        if (modelo.startsWith('openai/gpt-oss')) cuerpo.reasoning_effort = 'low';
        const texto = await pedirGroq(clave, cuerpo);
        return { modelo, datos: leerJSON(texto) };
      } catch (e) {
        ultimoError = e;
        if (e.status === 401) throw new Error('La clave de Groq no es válida (401)');
      }
    }
  }
  throw ultimoError || new Error('Groq no respondió');
}

// ---------------------------------------------------------------------
// Limpieza de la respuesta
// ---------------------------------------------------------------------
function limpiar(texto, max) {
  const t = String(texto || '').replace(/[*_#`]+/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const espacio = corte.lastIndexOf(' ');
  return `${corte.slice(0, espacio > max * 0.6 ? espacio : max).replace(/[\s,;:.]+$/, '')}…`;
}

// ¿La noticia de verdad trata del punto? Se cuentan palabras en común (por raíz
// de 5 letras, sin palabras vacías). Evita que la IA pegue fuentes de otro tema.
const VACIAS = new Set(['para', 'como', 'pero', 'sobre', 'entre', 'desde', 'hasta', 'tras', 'este', 'esta', 'estos',
  'estas', 'esto', 'tiene', 'tienen', 'hace', 'sido', 'sera', 'segun', 'donde', 'cuando', 'tambien', 'ante', 'contra',
  'durante', 'mientras', 'todo', 'todos', 'toda', 'todas', 'otro', 'otra', 'otros', 'otras', 'puede', 'pueden', 'dijo',
  'afirmo', 'anuncio', 'nuevo', 'nueva', 'nuevos', 'nuevas', 'anos', 'dias', 'parte', 'pais', 'paises', 'gobierno',
  'presidente', 'tras', 'luego', 'antes', 'despues', 'mayor', 'menor', 'gran', 'grandes', 'cada', 'sus', 'ellos',
  'ellas', 'porque', 'aunque', 'sobre', 'hacia', 'donde', 'mismo', 'misma', 'sigue', 'siguen', 'tras', 'importa']);

function raices(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const set = new Set();
  for (const p of t.split(/[^a-z0-9]+/)) {
    if (p.length < 4 || VACIAS.has(p)) continue;
    set.add(p.slice(0, 5));
  }
  return set;
}

function enComun(a, b) {
  let n = 0;
  for (const r of a) if (b.has(r)) n++;
  return n;
}

export function armarPuntos(datos, noticias) {
  const crudos = Array.isArray(datos?.puntos) ? datos.puntos : [];
  const usados = new Set();
  const puntos = [];
  for (const p of crudos) {
    const titulo = limpiar(p?.titulo, 90);
    const texto = limpiar(p?.texto, 480);
    if (!titulo || !texto) continue;
    const indices = (Array.isArray(p?.fuentes) ? p.fuentes : [])
      .map(x => parseInt(x, 10))
      .filter(i => Number.isInteger(i) && i >= 1 && i <= noticias.length);
    // Solo las fuentes que comparten tema con el punto (2+ palabras en común);
    // si ninguna llega a 2, queda la más parecida si comparte al menos 1
    const delPunto = raices(`${titulo} ${texto}`);
    const puntuadas = [...new Set(indices)].map(i => {
      const n = noticias[i - 1];
      return { i, comun: enComun(delPunto, raices(`${n.titulo} ${n.resumen}`)) };
    });
    let unicos = puntuadas.filter(f => f.comun >= 2).map(f => f.i);
    if (!unicos.length) {
      const mejor = puntuadas.sort((a, b) => b.comun - a.comun)[0];
      if (mejor && mejor.comun >= 1) unicos = [mejor.i];
    }
    unicos = unicos.slice(0, 4);
    if (!unicos.length) continue;                       // un punto sin respaldo no se muestra
    unicos.forEach(i => usados.add(i));
    puntos.push({
      titulo,
      texto,
      importancia: limpiar(p?.importancia, 260),
      fuentes: unicos.map(i => {
        const n = noticias[i - 1];
        return { titulo: n.titulo, fuente: n.fuente, urlFuente: n.urlFuente, fecha: n.fecha };
      })
    });
    if (puntos.length >= PUNTOS) break;
  }
  return puntos;
}

// ---------------------------------------------------------------------
// Vistazo del día (con caché en memoria y sin pedidos duplicados)
// ---------------------------------------------------------------------
const memoria = { dia: null, datos: null, enCurso: null, errorHasta: 0, ultimoError: null };

async function generar(dia) {
  const clave = (globalThis.process?.env?.GROQ_API_KEY || '').trim();
  if (!clave) {
    return { disponible: false, dia, motivo: 'sin-clave',
      mensaje: 'El resumen todavía no está activado: falta la clave de Groq en Vercel.' };
  }

  const ahora = new Date();
  const { noticias } = await obtener(false);
  const elegidas = elegirNoticias(noticias, ahora);
  if (elegidas.length < MIN_NOTICIAS) {
    return { disponible: false, dia, motivo: 'pocas-noticias', geopoliticas: elegidas.length,
      mensaje: 'Todavía hay pocas noticias geopolíticas hoy. Vuelve más tarde.' };
  }

  const mensajes = [
    { role: 'system', content: INSTRUCCIONES },
    { role: 'user', content: `Fecha: ${fechaLarga(dia)}.\n\nNoticias:\n${listaParaIA(elegidas)}` }
  ];
  const { modelo, datos } = await generarConIA(clave, mensajes);
  const puntos = armarPuntos(datos, elegidas);
  if (puntos.length < 3) throw new Error(`La IA devolvió solo ${puntos.length} puntos válidos`);

  return {
    disponible: true,
    dia,
    fechaLarga: fechaLarga(dia),
    generado: ahora.toISOString(),
    modelo,
    basadoEn: elegidas.length,
    medios: [...new Set(elegidas.map(n => n.fuente))],
    puntos
  };
}

export async function obtenerVistazo() {
  const dia = diaEdicion();
  if (memoria.dia === dia && memoria.datos) return memoria.datos;
  if (memoria.enCurso) return memoria.enCurso;
  if (Date.now() < memoria.errorHasta) throw memoria.ultimoError;

  memoria.enCurso = (async () => {
    try {
      const datos = await generar(dia);
      if (datos.disponible) {
        memoria.dia = dia;
        memoria.datos = datos;
      }
      return datos;
    } catch (e) {
      memoria.ultimoError = e;
      memoria.errorHasta = Date.now() + MINUTOS_ESPERA_ERROR * 60 * 1000;
      throw e;
    } finally {
      memoria.enCurso = null;
    }
  })();
  return memoria.enCurso;
}
