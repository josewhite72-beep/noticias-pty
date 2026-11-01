// GET /api/vistazo?dia=AAAA-MM-DD — Vistazo Geopolítico del día (5 puntos con fuentes)
// La app manda el día de la edición: así cada día tiene su propia dirección y la CDN
// de Vercel guarda el resumen todo el día (una sola llamada a Groq por día y región).
import { json } from '../lib/noticias.js';
import { obtenerVistazo, diaEdicion } from '../lib/vistazo.js';

export const config = { runtime: 'edge' };

const UN_DIA = 24 * 60 * 60;

export default async function handler(request) {
  const dia = new URL(request.url).searchParams.get('dia');
  const hoy = diaEdicion();
  const ayer = diaEdicion(new Date(Date.now() - UN_DIA * 1000));
  if (dia && dia !== hoy && dia !== ayer) {
    return json({ disponible: false, motivo: 'dia-invalido', mensaje: 'Día no válido' }, { status: 400 });
  }

  try {
    const v = await obtenerVistazo();
    if (!v.disponible) {
      // "Pocas noticias" se vuelve a intentar en 30 min; "sin clave", en cada visita
      return json(v, { segundosCdn: v.motivo === 'pocas-noticias' ? 30 * 60 : 0 });
    }
    // Con ?dia= de hoy, la CDN lo guarda todo el día; sin él, solo media hora
    return json(v, { segundosCdn: dia === hoy && v.dia === hoy ? UN_DIA : 30 * 60 });
  } catch (e) {
    return json({
      disponible: false,
      motivo: 'error',
      mensaje: 'No se pudo generar el Vistazo en este momento. Intenta de nuevo más tarde.',
      detalle: String(e && e.message || e).slice(0, 300)
    }, { status: 502 });
  }
}
