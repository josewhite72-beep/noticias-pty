// GET /api/estado — qué fuentes funcionaron, cuántas noticias trajo cada una
import { obtener, json, errorInterno } from '../lib/noticias.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    const forzar = new URL(request.url).searchParams.has('refrescar');
    const { estado, desdeCache } = await obtener(forzar);
    return json({ ...estado, desdeCache });
  } catch (e) {
    return errorInterno(e);
  }
}
