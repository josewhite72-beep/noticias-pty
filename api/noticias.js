// GET /api/noticias — lista de noticias para la app
import { obtener, json, errorInterno, MINUTOS_CACHE } from '../lib/noticias.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const forzar = new URL(request.url).searchParams.has('refrescar');
    const { noticias, estado, desdeCache } = await obtener(forzar);
    if (!noticias.length) return json({ error: 'No se pudo leer ninguna fuente', estado }, { status: 502 });
    return json(noticias, {
      segundosCdn: forzar ? 0 : MINUTOS_CACHE * 60,
      extra: { 'X-Generado': estado.generado, 'X-Desde-Cache': String(desdeCache) }
    });
  } catch (e) {
    return errorInterno(e);
  }
}
