// GET /api/buscar?q=texto — busca en los medios y devuelve resultados clasificados
import { buscar, json, errorInterno, MINUTOS_CACHE_BUSQUEDA } from '../lib/noticias.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const q = (new URL(request.url).searchParams.get('q') || '').replace(/\s+/g, ' ').trim();
    if (q.length < 2 || q.length > 120) return json({ error: 'Escribe entre 2 y 120 caracteres' }, { status: 400 });
    const datos = await buscar(q);
    // Solo se guarda en la CDN si hubo resultados
    return json(datos, { segundosCdn: datos.resultados.length ? MINUTOS_CACHE_BUSQUEDA * 60 : 0 });
  } catch (e) {
    return errorInterno(e);
  }
}
